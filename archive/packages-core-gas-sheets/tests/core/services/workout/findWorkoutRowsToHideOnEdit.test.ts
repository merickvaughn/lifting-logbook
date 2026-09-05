import { findWorkoutRowsToHideOnEdit } from "@src/core";

describe("findWorkoutRowsToHideOnEdit", () => {
  const workoutData = [
    ["Header1", "Header2", "Header3", "Header4"], // metadata row 0, index 0
    ["Metadata", "", "", ""], // row 2, index 1
    ["Lift", "Set", "Reps", "Weight"], // header row (row 3, index 2)
    ["Squat", "Warm-up", 5, 100], // row 4, index 3
    ["Squat", "Warm-up", 3, 120], // row 5, index 4
    ["Squat", "Working", 5, 140], // row 6, index 5
    ["Bench", "Warm-up", 5, 80], // row 7, index 6
    ["Bench", "Working", 3, 100], // row 8, index 7
  ];

  it("returns correct rows to hide for a working set's reps cell edit (Squat)", () => {
    // Editing row 4 (index 3), col 3 ("Reps" column, 1-based index 3+1=4)
    const editedRow = 5;
    const editedCol = 3; // "Reps" is at index 2, so col=3
    const rows = findWorkoutRowsToHideOnEdit(
      workoutData,
      editedRow - 1,
      editedCol - 1,
    );
    // Should hide all rows for the same lift above, so rows 4,3,2 (1-based)
    expect(rows).toEqual([4, 3]);
  });

  it("returns correct rows to hide for a working set's reps cell edit (Bench)", () => {
    // Editing row 6 (index 5), col 3 ("Reps" column)
    const editedRow = 6;
    const editedCol = 3;
    const rows = findWorkoutRowsToHideOnEdit(
      workoutData,
      editedRow - 1,
      editedCol - 1,
    );
    // Should hide all rows for the same lift above, so rows 5,4,3 (1-based)
    expect(rows).toEqual([5, 4, 3]);
  });

  it("throws an error if edited row is above reps header", () => {
    // Editing row 1 (header)
    const editedRow = 1;
    const editedCol = 3;
    expect(() =>
      findWorkoutRowsToHideOnEdit(workoutData, editedRow - 1, editedCol - 1),
    ).toThrow();
  });

  it("throws an error if edited column is not the reps column", () => {
    // Editing row 4, but column 1 ("Lift")
    const editedRow = 4;
    const editedCol = 1;
    expect(() =>
      findWorkoutRowsToHideOnEdit(workoutData, editedRow - 1, editedCol - 1),
    ).toThrow();
  });

  it("throws an error if no matching lift above", () => {
    // Editing row 2 (Squat, Warm-up), which is above any working set
    const editedRow = 2;
    const editedCol = 3;
    expect(() =>
      findWorkoutRowsToHideOnEdit(workoutData, editedRow - 1, editedCol - 1),
    ).toThrow();
  });
});
