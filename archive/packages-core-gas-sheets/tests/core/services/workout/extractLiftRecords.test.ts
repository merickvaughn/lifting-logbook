import {
  extractLiftRecords,
  parseLiftingProgramSpec,
  parseTrainingMaxes,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

const trainingMaxesData = loadCsvFixture("training_maxes.csv");
const rptProgramSpecData = loadCsvFixture("rpt_program_spec.csv");
const trainingMaxes = parseTrainingMaxes(trainingMaxesData);
const rptProgramSpec = parseLiftingProgramSpec(rptProgramSpecData);

describe("extractLiftRecords", () => {
  it("throws an error when program or cycle number is missing", () => {
    const data = loadCsvFixture("rpt_week_1_20260105_err.csv");
    expect(() => extractLiftRecords(data)).toThrow(
      "Missing required program or cycle number in lift records data.",
    );
  });
  it("throws an error when a header is missing", () => {
    const data = loadCsvFixture("rpt_week_1_20260105_err_2.csv");
    expect(() => extractLiftRecords(data)).toThrow(
      "Unexpected column header 'TM' at row 16, column 4.",
    );
  });
  it("extracts valid lift records from a 2D grid, skipping incomplete rows", () => {
    const data = loadCsvFixture("rpt_week_1_20260105.csv");
    const records = extractLiftRecords(data);
    // Should only include rows with all required fields (Date, Lift, Set, Weight, Reps)
    expect(Array.isArray(records)).toBe(true);
    // Should have the expected number of work sets (excluding warm-ups and incomplete rows)
    expect(records.length).toBe(22);
    // Check a few known records
    expect(records).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          program: "RPT",
          cycleNum: 1,
          workoutNum: 1,
          date: "1/5/2026",
          lift: "Bench P.",
          setNum: 1,
          weight: 72.5,
          reps: 5,
        }),
      ]),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          program: "RPT",
          cycleNum: 1,
          workoutNum: 1,
          date: "1/5/2026",
          lift: "Bench P.",
          setNum: 1,
          weight: 182.5,
          reps: 6,
          notes: "Might consider a different activation exercise.",
        }),
        expect.objectContaining({
          program: "RPT",
          cycleNum: 1,
          workoutNum: 3,
          date: "1/13/2026",
          lift: "Deadlift",
          setNum: 2,
          weight: 237.5,
          reps: 9,
        }),
      ]),
    );
    // Should skip rows missing required fields (e.g., OH Press-HV Set 1)
    expect(
      records.find((r) => r.lift === "OH Press-HV" && r.setNum === 1),
    ).toBeUndefined();
  });
});
