import { REPS_HEADER } from "@src/core/constants";
import { SpreadsheetCell } from "@src/core/models";

/**
 * Given the sheet data and the edited row,
 * returns the rows to hide when a working set's reps cell is edited.
 * Hides the working set row and any warm-up rows for the same lift above it.
 *
 * @param workoutData 2D array of sheet values
 * @param editedRow number (1-based) of the edited row
 * @param editedCol number (1-based) of the edited column
 * @returns array of 1-based row numbers to hide
 */
export function findWorkoutRowsToHideOnEdit(
  workoutData: SpreadsheetCell[][],
  editedRow: number,
  editedCol: number,
): number[] {
  const rowsToHide: number[] = [];
  const repsRow = workoutData.findIndex((row) => row.includes(REPS_HEADER));
  if (repsRow === -1) throw new Error("Reps header row not found.");
  const repsHeaderRow = workoutData[repsRow]!;
  const repsCol = repsHeaderRow.indexOf(REPS_HEADER);

  // If edited column is not the "Reps" column, return empty array
  if (editedCol !== repsCol)
    throw new Error("Edited column is not the Reps column.");
  // If edited row is above reps header, return empty array
  if (editedRow <= repsRow)
    throw new Error("Edited row is above the data entry section.");

  // Find column indices for "Set" and "Lift" in the reps header row
  const LIFT_COL = repsHeaderRow.indexOf("Lift");
  const editedRowData = workoutData[editedRow];
  if (!editedRowData) throw new Error(`No data row at index ${editedRow}.`);
  const currLift = editedRowData[LIFT_COL];

  for (let r = editedRow; r > repsRow; r--) {
    const row = workoutData[r];
    if (row && row[LIFT_COL] === currLift) {
      // workoutRepo.hideRow(r + 1);
      rowsToHide.push(r);
    }
    // if (allValues[r][SET_TYPE_COL] === "Warm-up") ;
  }
  return rowsToHide;
}
