import {
  CORE_LIFT_HEADER,
  DATE_HEADER,
  LIFT_DATE_HEADER,
  LIFT_HEADER,
  NOTES_HEADER,
} from "@src/core/constants";
import { LiftingProgramSpec, SpreadsheetCell } from "@src/core/models";

/**
 * Updates lift dates for lifts with the same offset as the edited lift.
 * @param data 2D array of workout sheet values.
 * @param programSpec Program specification object.
 * @param editedCellRow Row index of the edited cell.
 * @returns Updated 2D array with lift dates synchronized.
 */
export function updateLiftDates(
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
  const workoutEntryHeaderRowIdx = data.findIndex((row) =>
    row.includes(NOTES_HEADER),
  );
  if (workoutEntryHeaderRowIdx === -1)
    throw new Error("Workout entry header row not found.");
  const entryHeaderRow = data[workoutEntryHeaderRowIdx]!;
  const entryLiftIdx = entryHeaderRow.indexOf(LIFT_HEADER);
  const entryDateIdx = entryHeaderRow.indexOf(DATE_HEADER);
  const workoutMetaHeaderRow = data[workoutMetaHeaderRowIdx]!;
  const coreLiftIdx = workoutMetaHeaderRow.indexOf(CORE_LIFT_HEADER);
  // indexOf is guaranteed non-negative: the row was found by row.includes(LIFT_DATE_HEADER).
  const liftDateIdx = workoutMetaHeaderRow.indexOf(LIFT_DATE_HEADER);
  const editedLiftData = data[editedCellRow];
  if (!editedLiftData)
    throw new Error(`No data row at index ${editedCellRow}.`);
  const editedLiftName = editedLiftData[coreLiftIdx];
  const editedLiftDate = editedLiftData[liftDateIdx];
  if (
    editedLiftDate == null ||
    (typeof editedLiftDate !== "string" &&
      typeof editedLiftDate !== "number" &&
      !(editedLiftDate instanceof Date)) ||
    isNaN(new Date(editedLiftDate as string | number | Date).getTime())
  )
    throw new Error(
      `Expected a valid date in the ${LIFT_DATE_HEADER} column at row ${editedCellRow}, got ${String(editedLiftDate)}.`,
    );
  const editedOffset = programSpecs.find(
    (spec) => spec.lift === editedLiftName,
  )?.offset;

  // If edited column is not the "Lift Date" column, return empty array
  if (editedCellCol !== liftDateIdx)
    throw new Error("Edited column is not the Lift Date column.");
  // If edited row is above reps header, return empty array
  if (editedCellRow >= workoutEntryHeaderRowIdx)
    throw new Error("Edited row is not in the metadata section.");

  console.log(
    `Edited lift: ${String(editedLiftName)}, Date: ${String(editedLiftDate)}, Offset: ${editedOffset}.`,
  );
  // Find all lifts with the same offset (including the edited lift)
  const otherLiftsWithSameOffset = programSpecs
    .filter(
      (spec) => spec.offset === editedOffset && spec.lift !== editedLiftName,
    )
    ?.map((spec) => spec.lift);

  console.log(
    `Other lifts with same offset (${editedOffset}): ${otherLiftsWithSameOffset}.`,
  );
  // Update meta header row for all lifts with the same offset
  otherLiftsWithSameOffset.forEach((liftName) => {
    const rowIdx = data.findIndex((row) => row[coreLiftIdx] === liftName);
    if (rowIdx === -1) throw new Error(`Meta row for lift ${liftName} not found.`);
    const metaRow = data[rowIdx]!;
    console.log(
      `Updating lift ${liftName} at row ${rowIdx} from ${String(metaRow[liftDateIdx])} to date ${String(editedLiftDate)}.`,
    );
    metaRow[liftDateIdx] = new Date(editedLiftDate as string | number | Date);
  });
  // Update entry rows for all lifts with the same offset
  [editedLiftName, ...otherLiftsWithSameOffset].forEach((liftName) => {
    data
      .filter((row) => row[entryLiftIdx] === liftName)
      .forEach((row) => {
        console.log(
          `Updating entry for lift ${String(liftName)} from ${String(row[entryDateIdx])} to date ${String(editedLiftDate)}.`,
        );
        row[entryDateIdx] = new Date(editedLiftDate as string | number | Date);
      });
  });
  return data;
}
