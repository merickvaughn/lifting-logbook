import {
  CYCLE_DATE_KEY,
  CYCLE_NUM_KEY,
  CYCLE_START_WEEKDAY_KEY,
  CYCLE_UNIT_KEY,
  CycleDashboard,
  mapCycleDashboard,
  PROGRAM_KEY,
  SHEET_NAME_KEY,
  Weekday,
} from "@src/core";

describe("mapCycleDashboard", () => {
  it("should map CycleDashboard object to 2D array with all keys", () => {
    const obj: CycleDashboard = {
      program: "5/3/1",
      cycleUnit: "Week",
      cycleNum: 1,
      cycleDate: new Date("2026-01-01"),
      sheetName: "Week 1",
      cycleStartWeekday: Weekday.Friday,
    };
    const result = mapCycleDashboard(obj);
    expect(result).toEqual([
      ["Key", "Value"],
      [PROGRAM_KEY, "5/3/1"],
      [CYCLE_UNIT_KEY, "Week"],
      [CYCLE_NUM_KEY, 1],
      [CYCLE_DATE_KEY, new Date("2026-01-01")],
      [SHEET_NAME_KEY, "Week 1"],
      [CYCLE_START_WEEKDAY_KEY, Weekday.Friday],
    ]);
  });
});
