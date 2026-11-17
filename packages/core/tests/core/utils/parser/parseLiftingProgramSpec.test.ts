import { parseLiftingProgramSpec, validateProgramSpecImport } from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("parseLiftingProgramSpec", () => {
  it("parses rpt_program_spec.csv to array of LiftingProgramSpec objects", () => {
    const data = loadCsvFixture("rpt_program_spec.csv");
    const result = parseLiftingProgramSpec(data);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!).toHaveProperty("offset");
    expect(result[0]!).toHaveProperty("lift");
    expect(result[0]!).toHaveProperty("increment");
    expect(result[0]!).toHaveProperty("order");
    expect(result[0]!).toHaveProperty("sets");
    expect(result[0]!).toHaveProperty("reps");
    expect(result[0]!).toHaveProperty("amrap");
    expect(result[0]!).toHaveProperty("warmUpPct");
    expect(result[0]!).toHaveProperty("wtDecrementPct");
    expect(result[0]!).toHaveProperty("activation");
  });
});

describe("parseLiftingProgramSpec + validateProgramSpecImport: a spec with no Week column", () => {
  // The 2026 RPT_PROGRAM_SPEC header: one repeated week, so no Week column.
  const header = ["Offset", "Lift", "Increment", "Order", "Sets", "Reps", "AMRAP?", "Warm-Up %", "WT Decrement %", "Activation"];
  const data = [
    header,
    ["-1", "Squat", "5", "1", "3", "5", "FALSE", "40,60", "0.05", ""],
    ["0", "Bench Press", "5", "1", "3", "5", "TRUE", "40,60", "0.05", ""],
  ];

  it("puts every row in week 1 and validates with no errors", () => {
    const rows = parseLiftingProgramSpec(data);
    expect(rows.map((r) => r.week)).toEqual([1, 1]);
    expect(rows.map((r) => r.offset)).toEqual([-1, 0]);
    expect(validateProgramSpecImport(rows)).toEqual({ valid: rows, errors: [] });
  });

  it("keeps reading the Week column when there is one", () => {
    const rows = parseLiftingProgramSpec([["Week", ...header], ["4", ...data[1]!]]);
    expect(rows[0]!.week).toBe(4);
    expect(validateProgramSpecImport(rows).errors).toEqual([
      expect.objectContaining({ row: 1, field: "week", message: "Week must be 1, 2, or 3" }),
    ]);
  });
});
