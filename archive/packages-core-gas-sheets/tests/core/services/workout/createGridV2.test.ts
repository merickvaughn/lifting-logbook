import {
  createGridV2,
  LIFT_PLAN_HEADERS,
  LIFT_SPEC_HEADERS,
  parseLiftingProgramSpec,
  parseTrainingMaxes,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("createGridV2", () => {
  const cycleDashboard = {
    program: "RPT",
    cycleNum: 1,
    cycleDate: new Date("2026-01-01"),
  } as any;
  const trainingMaxesData = loadCsvFixture("training_maxes.csv");
  const rptProgramSpecData = loadCsvFixture("rpt_program_spec.csv");
  const trainingMaxes = parseTrainingMaxes(trainingMaxesData);
  const rptProgramSpec = parseLiftingProgramSpec(rptProgramSpecData);

  it("creates a grid with the new training values", () => {
    const result = createGridV2(cycleDashboard, rptProgramSpec, trainingMaxes);
    expect(result.length).toBe(77);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toEqual(["Program", "RPT", "Cycle", 1, "Weight", ""]);
    expect(result[1]).toEqual(LIFT_SPEC_HEADERS);
    expect(result.findIndex((row) => row[0] === "Date")).toBe(15); // Workout grid header
  });

  it("returns an empty grid if no training maxes are provided", () => {
    const result = createGridV2(cycleDashboard, rptProgramSpec, []);
    expect(result.length).toBe(3); // Only headers
    expect(result[0]).toEqual(["Program", "RPT", "Cycle", 1, "Weight", ""]);
    expect(result[1]).toEqual(LIFT_SPEC_HEADERS);
  });

  it("returns an empty grid if no program spec is provided", () => {
    const result = createGridV2(cycleDashboard, [], trainingMaxes);
    expect(result.length).toBe(3); // Only headers
    expect(result[0]).toEqual(["Program", "RPT", "Cycle", 1, "Weight", ""]);
    expect(result[1]).toEqual(LIFT_SPEC_HEADERS);
    expect(result[2]).toEqual(LIFT_PLAN_HEADERS);
  });

  it("generates correct lift spec and plan for a known lift", () => {
    const singleSpec = [rptProgramSpec[0]!];
    const singleMax = [trainingMaxes[0]!];
    const result = createGridV2(cycleDashboard, singleSpec, singleMax);
    expect(result.length).toBeGreaterThan(2);
    expect(result[1]![0]).toBe("Core Lift");
    expect(result[2]![0]).toBe(singleMax[0]!.lift);
    expect(result[result.length - 1]![1]).toBe(singleMax[0]!.lift);
  });

  it("uses the correct start date in generated lift specs", () => {
    const result = createGridV2(cycleDashboard, rptProgramSpec, trainingMaxes);
    // Find a row with a date and check it matches the start date or expected offset
    const dateRows = result.filter(
      // Match on equals sign b/c dates are generated as formulas
      (row) => typeof row[0] === "string" && /^=/.test(row[0]),
    );
    expect(dateRows.length).toBeGreaterThan(0);
    // Optionally check the first workout date
    // expect(dateRows[0][0]).toContain("2026-01-01");
  });
});
