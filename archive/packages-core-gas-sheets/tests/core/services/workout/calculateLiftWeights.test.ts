import {
  calculateLiftWeights,
  LIFT_DATE_HEADER,
  LIFT_WEIGHT_HEADER,
  parseLiftingProgramSpec,
  SPEC_WEIGHT_HEADER,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("calculateLiftWeights", () => {
  const workoutData = loadCsvFixture("rpt_week_1_20260105.csv");
  const rptProgramSpecData = loadCsvFixture("rpt_program_spec.csv");
  const rptProgramSpec = parseLiftingProgramSpec(rptProgramSpecData);

  const metaHeaderRowIdx = workoutData.findIndex((row) =>
    row.includes(LIFT_DATE_HEADER),
  );
  const entryHeaderRowIdx = workoutData.findIndex((row) =>
    row.includes("Notes"),
  );
  const liftTmIdx = workoutData[metaHeaderRowIdx]!.indexOf(SPEC_WEIGHT_HEADER);
  const entryWeightIdx =
    workoutData[entryHeaderRowIdx]!.indexOf(LIFT_WEIGHT_HEADER);
  const liftSpecRowIdx = workoutData.findIndex(
    (row) => row.includes("Squat") && row.includes("KB Swing"),
  );

  it("throws an error if SPEC_WEIGHT_HEADER is absent from the meta header row", () => {
    const dataWithoutWeightHeader = workoutData.map((row) =>
      row.map((cell) => (cell === SPEC_WEIGHT_HEADER ? "" : cell)),
    );
    expect(() =>
      calculateLiftWeights(
        dataWithoutWeightHeader,
        rptProgramSpec,
        liftSpecRowIdx,
        liftTmIdx,
      ),
    ).toThrow(/not found in workout meta header row/);
  });

  it("throws an error if edited column is not the Weight column", () => {
    workoutData[liftSpecRowIdx]![liftTmIdx] = 105; // Set a known TM value for testing
    expect(() =>
      calculateLiftWeights(
        workoutData,
        rptProgramSpec,
        liftSpecRowIdx,
        liftTmIdx + 1,
      ),
    ).toThrow();
  });

  it("throws an error if edited row is not the Weight row", () => {
    workoutData[liftSpecRowIdx]![liftTmIdx] = 105; // Set a known TM value for testing
    expect(() =>
      calculateLiftWeights(workoutData, rptProgramSpec, -1, liftTmIdx),
    ).toThrow();
  });

  it("modifies all lift weights of core lift with matching offset", () => {
    workoutData[liftSpecRowIdx]![liftTmIdx] = 105; // Set a known TM value for testing
    const result = calculateLiftWeights(
      workoutData,
      rptProgramSpec,
      liftSpecRowIdx,
      liftTmIdx,
    );
    const expectedWeights = [42.5, 62.5, 85, 105, 95, 85];
    const actualWeights = Array.from(
      { length: 6 },
      (_, i) => result[41 + i]![entryWeightIdx],
    );
    expect(result.length).toBe(77);
    expect(Array.isArray(result)).toBe(true);
    expect(actualWeights).toEqual(expectedWeights);
  });
});
