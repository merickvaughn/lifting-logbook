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

describe("parseLiftingProgramSpec without a Week column (#1312)", () => {
  const header = [
    "Offset", "Lift", "Increment", "Order", "Sets", "Reps",
    "AMRAP?", "Warm-Up %", "WT Decrement %", "Activation",
  ];
  const spec2026 = [
    header,
    [-1, "Squat", 5, 1, 3, 8, "FALSE", ".6", 0.05, "Glute Bridge"],
    [0, "Bench P.", 2.5, 1, 3, 8, "TRUE", ".6", 0.05, "Band Flye"],
  ];

  it("parses and validates with week 1 on every row, including a negative offset", () => {
    const rows = parseLiftingProgramSpec(spec2026);
    const { valid, errors } = validateProgramSpecImport(rows);
    expect(errors).toEqual([]);
    expect(valid.map((r) => r.week)).toEqual([1, 1]);
    expect(valid.map((r) => r.offset)).toEqual([-1, 0]);
  });

  it("keeps reading the Week column when there is one", () => {
    const withWeek = [["Week", ...header], [4, 0, "Bench P.", 2.5, 1, 3, 8, "TRUE", ".6", 0.05, "x"]];
    const { errors } = validateProgramSpecImport(parseLiftingProgramSpec(withWeek));
    expect(errors.map((e) => e.message)).toEqual(["Week must be 1, 2, or 3"]);
  });
});
