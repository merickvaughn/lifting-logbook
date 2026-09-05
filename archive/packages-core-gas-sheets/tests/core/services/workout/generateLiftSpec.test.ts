import {
  generateLiftSpec,
  LIFT_SPEC_HEADERS,
  parseLiftingProgramSpec,
  parseTrainingMaxes,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

const trainingMaxesData = loadCsvFixture("training_maxes.csv");
const rptProgramSpecData = loadCsvFixture("rpt_program_spec.csv");
const trainingMaxes = parseTrainingMaxes(trainingMaxesData);
const rptProgramSpec = parseLiftingProgramSpec(rptProgramSpecData);

describe("generateLiftSpec", () => {
  it("generates correct lift spec for Bench P.", () => {
    const tm = trainingMaxes.find((t) => t.lift === "Bench P.")!;
    const ps = rptProgramSpec.find((p) => p.lift === "Bench P.")!;
    const startDate = new Date(2026, 0, 1); // Jan 1, 2026
    const result = generateLiftSpec(tm, ps, startDate);
    expect(result[LIFT_SPEC_HEADERS.indexOf("Core Lift")]).toBe("Bench P."); // lift
    expect(result[LIFT_SPEC_HEADERS.indexOf("Scheme")]).toBe("3 × 8"); // sets × reps
    expect(result[LIFT_SPEC_HEADERS.indexOf("Inc. Amt.")]).toBe(2.5); // increment
    expect(result[LIFT_SPEC_HEADERS.indexOf("TM")]).toBe(182.5); // weight
    expect(result[LIFT_SPEC_HEADERS.indexOf("Lift Date")]).toEqual(
      new Date(2026, 0, 1),
    ); // offset 0
    expect(result[LIFT_SPEC_HEADERS.indexOf("Activ. Ex.")]).toBe("Band Flye"); // activation
  });
  it("generates correct lift spec for Deadlift", () => {
    const tm = trainingMaxes.find((t) => t.lift === "Deadlift")!;
    const ps = rptProgramSpec.find((p) => p.lift === "Deadlift")!;
    const startDate = new Date(2026, 0, 1);
    const result = generateLiftSpec(tm, ps, startDate);
    expect(result[LIFT_SPEC_HEADERS.indexOf("Core Lift")]).toBe("Deadlift"); // lift
    expect(result[LIFT_SPEC_HEADERS.indexOf("Scheme")]).toBe("2 × 6"); // sets × reps
    expect(result[LIFT_SPEC_HEADERS.indexOf("Inc. Amt.")]).toBe(2.5); // increment
    expect(result[LIFT_SPEC_HEADERS.indexOf("TM")]).toBe(275); // weight
    expect(result[LIFT_SPEC_HEADERS.indexOf("Lift Date")]).toEqual(
      new Date(2026, 0, 5),
    ); // offset 4
    expect(result[LIFT_SPEC_HEADERS.indexOf("Activ. Ex.")]).toBe("KB Swing"); // activation
  });
});
