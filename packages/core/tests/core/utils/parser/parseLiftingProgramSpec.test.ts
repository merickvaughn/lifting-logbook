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

describe("parseLiftingProgramSpec: a Weight % column in place of WT Decrement %", () => {
  const header = ["Week", "Offset", "Lift", "Increment", "Order", "Sets", "Reps", "AMRAP?", "Warm-Up %", "Weight %", "Activation"];
  const specOf = (...lists: string[]) => [
    header,
    ...lists.map((l) => [1, 0, "Squat", 5, 1, 3, 5, "FALSE", "0.5", l, ""]),
  ];

  it("reads an evenly stepped list as the matching decrement", () => {
    const rows = parseLiftingProgramSpec(specOf("1,.95,.9", "1,.9", "1,.9,.8"));
    expect(rows.map((r) => r.wtDecrementPct)).toEqual([0.05, 0.1, 0.1]);
    expect(validateProgramSpecImport(rows).errors).toEqual([]);
  });

  it("gives an unevenly stepped list one row error naming the row and the field", () => {
    const rows = parseLiftingProgramSpec(specOf("1,.9", "1,.95,.8"));
    const { errors } = validateProgramSpecImport(rows);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 2, field: "weightPct" });
    expect(errors[0]!.message).toContain("Weight %");
  });
});

// `Weight %` joined the header map in #1401 so the column mapper can match it. The parser's
// generic header loop must still leave it alone: a sheet carrying both columns states its drop
// in `WT Decrement %`, and a populated `weightPct` would re-point that column's validation
// error at `weightPct` with a message about an evenly stepped list.
describe("parseLiftingProgramSpec: a sheet carrying both percent columns", () => {
  const header = ["Week", "Offset", "Lift", "Increment", "Order", "Sets", "Reps", "AMRAP?", "Warm-Up %", "WT Decrement %", "Weight %", "Activation"];
  const specOf = (decrement: unknown) => [
    header,
    [1, 0, "Squat", 5, 1, 3, 5, "FALSE", "0.5", decrement, "1,.8,.7", ""],
  ];

  it("takes the decrement from WT Decrement % and leaves weightPct unset", () => {
    const rows = parseLiftingProgramSpec(specOf(0.05));
    expect(rows[0]!.wtDecrementPct).toBe(0.05);
    expect(rows[0]!.weightPct).toBeUndefined();
    expect(validateProgramSpecImport(rows).errors).toEqual([]);
  });

  it("reports a bad WT Decrement % under wtDecrementPct, not weightPct", () => {
    const { errors } = validateProgramSpecImport(parseLiftingProgramSpec(specOf("n/a")));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 1, field: "wtDecrementPct" });
  });
});
