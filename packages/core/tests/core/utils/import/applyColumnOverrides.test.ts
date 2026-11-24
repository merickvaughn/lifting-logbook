import { applyColumnOverrides, parseLiftingProgramSpec, validateProgramSpecImport } from "@src/core";
import type { SpreadsheetCell } from "@src/core/models";

// A required field's Map columns row names which of the file's columns holds it, and that
// choice is sent as an override (#1442). The override is only worth sending if the renamed
// column is then the one the destination's parser reads, so these go end to end: override in,
// parsed program spec out.
describe("applyColumnOverrides: a chosen column reaches the parser", () => {
  const header = ["Offset", "Lift", "Increment", "Order", "Sets", "Reps", "AMRAP?", "Warm-Up %"];
  const specOf = (dropHeader: string, drop: SpreadsheetCell): SpreadsheetCell[][] => [
    [...header, dropHeader],
    [0, "Squat", 5, 1, 3, 5, "FALSE", "0.5", drop],
  ];

  it("reads a per-set list from a column chosen as Weight %", () => {
    const table = applyColumnOverrides(specOf("Set Weights", "1,.95,.9"), { "Set Weights": "weightPct" }, "program-spec");

    expect(table[0]).toContain("Weight %");
    expect(table[0]).not.toContain("Set Weights");

    const rows = parseLiftingProgramSpec(table);
    expect(rows).toEqual([expect.objectContaining({ weightPct: "1,.95,.9", wtDecrementPct: 0.05 })]);
    expect(validateProgramSpecImport(rows).errors).toEqual([]);
  });

  it("reads a single step from a column chosen as WT Decrement %", () => {
    const table = applyColumnOverrides(specOf("Drop", 0.05), { Drop: "wtDecrementPct" }, "program-spec");

    const rows = parseLiftingProgramSpec(table);
    expect(rows).toEqual([expect.objectContaining({ wtDecrementPct: 0.05 })]);
    expect(validateProgramSpecImport(rows).errors).toEqual([]);
  });

  // Without the rename the parser never sees the column, which is what makes a required
  // field's row worthless unless its choice is sent.
  it("leaves the spec without a decrement when the column is not renamed", () => {
    const rows = parseLiftingProgramSpec(specOf("Set Weights", "1,.95,.9"));

    expect(rows[0]).not.toHaveProperty("weightPct");
    expect(rows[0]!.wtDecrementPct).toBeNaN();
    expect(validateProgramSpecImport(rows).errors).not.toEqual([]);
  });
});
