import {
  DATE_HEADER,
  LIFT_DATE_HEADER,
  parseLiftingProgramSpec,
  updateLiftDates,
} from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("updateLiftDates", () => {
  const workoutData = loadCsvFixture("rpt_week_1_20260105.csv");
  const rptProgramSpecData = loadCsvFixture("rpt_program_spec.csv");
  const rptProgramSpec = parseLiftingProgramSpec(rptProgramSpecData);
  const metaHeaderRowIdx = workoutData.findIndex((row) =>
    row.includes(LIFT_DATE_HEADER),
  );
  const liftSpecColIdx =
    workoutData[metaHeaderRowIdx]!.indexOf(LIFT_DATE_HEADER);
  const entryHeaderRowIdx = workoutData.findIndex((row) =>
    row.includes("Notes"),
  );
  const entryLiftDateIdx = workoutData[entryHeaderRowIdx]!.indexOf(DATE_HEADER);
  const liftSpecRowIdx = workoutData.findIndex(
    (row) => row.includes("Squat") && row.includes("KB Swing"),
  );
  const newLiftDate = new Date(2026, 0, 15); // Jan 15, 2026

  it("throws an error if the lift date cell contains an invalid date value", () => {
    const dataWithBadDate = workoutData.map((row) => [...row]);
    dataWithBadDate[liftSpecRowIdx]![liftSpecColIdx] = "not-a-date";
    expect(() =>
      updateLiftDates(
        dataWithBadDate,
        rptProgramSpec,
        liftSpecRowIdx,
        liftSpecColIdx,
      ),
    ).toThrow(/Expected a valid date/);
  });

  it("throws an error if edited row is not a lift spec row", () => {
    expect(() =>
      updateLiftDates(workoutData, rptProgramSpec, -1, liftSpecColIdx),
    ).toThrow();
  });

  it("throws an error if edited column is not the lift date column", () => {
    expect(() =>
      updateLiftDates(workoutData, rptProgramSpec, liftSpecRowIdx, -1),
    ).toThrow();
  });

  it("modifies all lift dates of core lifts with matching offset", () => {
    workoutData[liftSpecRowIdx]![liftSpecColIdx] = newLiftDate;
    const result = updateLiftDates(
      workoutData,
      rptProgramSpec,
      liftSpecRowIdx,
      liftSpecColIdx,
    );
    expect(result.length).toBe(77);
    expect(Array.isArray(result)).toBe(true);
    Array.from({ length: 4 }, (_, i) => 7 + i).forEach((rowIdx) => {
      expect(result[rowIdx]![liftSpecColIdx]).toEqual(newLiftDate);
    });
    Array.from({ length: 18 }, (_, i) => 42 + i).forEach((rowIdx) => {
      expect(result[rowIdx]![entryLiftDateIdx]).toEqual(newLiftDate);
    });
  });
});
