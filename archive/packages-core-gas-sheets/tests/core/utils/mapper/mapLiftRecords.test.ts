import { LIFT_RECORD_HEADER_MAP, LiftRecord, mapLiftRecords } from "@src/core";

describe("mapLiftRecords", () => {
  it("should map LiftRecord[] to 2D array with all columns and headers", () => {
    const headers = Object.keys(LIFT_RECORD_HEADER_MAP);
    const records: LiftRecord[] = [
      {
        program: "5/3/1",
        cycleNum: 1,
        workoutNum: 1,
        date: new Date("2026-01-01"),
        lift: "Squat",
        setNum: 1,
        weight: 100,
        reps: 5,
        notes: "First set",
      },
      {
        program: "5/3/1",
        cycleNum: 1,
        workoutNum: 1,
        date: new Date("2026-01-01"),
        lift: "Squat",
        setNum: 2,
        weight: 110,
        reps: 3,
        notes: "Second set",
      },
    ];
    const result = mapLiftRecords(records);
    expect(result[0]).toEqual(headers);
    expect(result[1]).toEqual([
      "5/3/1",
      1,
      1,
      new Date("2026-01-01"),
      "Squat",
      1,
      100,
      5,
      "First set",
    ]);
    expect(result[2]).toEqual([
      "5/3/1",
      1,
      1,
      new Date("2026-01-01"),
      "Squat",
      2,
      110,
      3,
      "Second set",
    ]);
  });
});
