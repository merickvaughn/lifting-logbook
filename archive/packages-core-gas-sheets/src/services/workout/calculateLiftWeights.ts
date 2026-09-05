import {
  CORE_LIFT_HEADER,
  LIFT_DATE_HEADER,
  LIFT_HEADER,
  LIFT_WEIGHT_HEADER,
  MROUND,
  NOTES_HEADER,
  PROG_SPEC_WARMUP_PCTS,
  PROG_SPEC_WORK_PCTS,
  SET_HEADER,
  SPEC_WEIGHT_HEADER,
} from "@src/core/constants";
import { LiftingProgramSpec, SpreadsheetCell } from "@src/core/models";

/**
 * Updates lift dates for lifts with the same offset as the edited lift.
 * @param data 2D array of workout sheet values.
 * @param programSpec Program specification object.
 * @param editedCellRow Row index of the edited cell.
 * @returns Updated 2D array with lift dates synchronized.
 */
export function calculateLiftWeights(
  data: SpreadsheetCell[][],
  programSpecs: LiftingProgramSpec[],
  editedCellRow: number,
  editedCellCol: number,
): SpreadsheetCell[][] {
  const workoutMetaHeaderRowIdx = data.findIndex((row) =>
    row.includes(LIFT_DATE_HEADER),
  );
  if (workoutMetaHeaderRowIdx === -1)
    throw new Error("Workout meta header row not found.");
  const workoutMetaHeaderRow = data[workoutMetaHeaderRowIdx]!;
  const workoutEntryHeaderRowIdx = data.findIndex((row) =>
    row.includes(NOTES_HEADER),
  );
  if (workoutEntryHeaderRowIdx === -1)
    throw new Error("Workout entry header row not found.");
  const entryHeaderRow = data[workoutEntryHeaderRowIdx]!;
  const entryLiftIdx = entryHeaderRow.indexOf(LIFT_HEADER);
  const entrySetIdx = entryHeaderRow.indexOf(SET_HEADER);
  const entryWeightIdx = entryHeaderRow.indexOf(LIFT_WEIGHT_HEADER);
  const coreLiftIdx = workoutMetaHeaderRow.indexOf(CORE_LIFT_HEADER);
  const metaWeightIdx = workoutMetaHeaderRow.indexOf(SPEC_WEIGHT_HEADER);
  if (metaWeightIdx === -1)
    throw new Error(`${SPEC_WEIGHT_HEADER} not found in workout meta header row.`);
  const editedLiftData = data[editedCellRow];
  if (!editedLiftData)
    throw new Error(`No data row at index ${editedCellRow}.`);
  const editedLiftName = editedLiftData[coreLiftIdx];
  const currLiftSpec = programSpecs.find(
    (spec) => spec.lift === editedLiftName,
  );
  const editedOffset = currLiftSpec?.offset;
  const currLiftTm = editedLiftData[metaWeightIdx];
  if (typeof currLiftTm !== "number" || isNaN(currLiftTm))
    throw new Error(
      `Expected a number in the ${SPEC_WEIGHT_HEADER} column at row ${editedCellRow}, got ${String(currLiftTm)}.`,
    );
  const currLiftIncrement = currLiftSpec?.increment || 1;

  // If edited column is not the "Reps" column, return empty array
  if (editedCellCol !== metaWeightIdx)
    throw new Error("Edited column is not the Weight column.");
  // If edited row is above reps header, return empty array
  if (editedCellRow >= workoutEntryHeaderRowIdx)
    throw new Error("Edited row is not in the metadata section.");

  console.log(
    `Edited lift: ${String(editedLiftName)}, Weight: ${currLiftTm}, Offset: ${editedOffset}.`,
  );

  const progSpecWarmPcts: number[] = PROG_SPEC_WARMUP_PCTS(
    currLiftSpec?.warmUpPct || "",
  );
  progSpecWarmPcts.forEach((pct, idx) => {
    console.log(`Warmup pct ${idx + 1}: ${pct}`);
    const dataRow = data.find(
      (row) =>
        row[entryLiftIdx] === editedLiftName &&
        row[entrySetIdx] === `Warm-up ${idx + 1}`,
    );
    if (dataRow) {
      dataRow[entryWeightIdx] = MROUND(currLiftTm * pct, currLiftIncrement);
    }
  });

  const progSpecWorkPcts: number[] = PROG_SPEC_WORK_PCTS(
    currLiftSpec?.sets || 0,
    currLiftSpec?.wtDecrementPct || 0,
  );
  progSpecWorkPcts.forEach((pct, idx) => {
    console.log(`Workset pct ${idx + 1}: ${pct}`);
    const dataRow = data.find(
      (row) =>
        row[entryLiftIdx] === editedLiftName &&
        row[entrySetIdx] === `Set ${idx + 1}`,
    );
    if (dataRow) {
      dataRow[entryWeightIdx] = MROUND(currLiftTm * pct, currLiftIncrement);
    }
  });

  return data;
}
