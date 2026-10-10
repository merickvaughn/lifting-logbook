import { MacrocycleDashboard, updateMacrocycle, Weekday } from "@src/core";

describe("updateMacrocycle", () => {
  it("increments macrocycleNum, updates macrocycleDate and sheetName for next Monday", () => {
    const prev: MacrocycleDashboard = {
      program: "RPT",
      macrocycleUnit: "Week",
      macrocycleNum: 1,
      macrocycleDate: new Date(2026, 0, 5, 0, 0, 0, 0),
      sheetName: "RPT_Cycle_1_20260105",
      macrocycleStartWeekday: Weekday.Monday,
    };
    const overrides = {
      targetWeekday: "Monday" as Weekday,
      today: new Date(2026, 0, 20, 0, 0, 0, 0),
    };
    const updated = updateMacrocycle(prev, overrides);
    expect(updated.macrocycleNum).toBe(2);
    expect(updated.sheetName).toBe("RPT_Cycle_2_20260119");
    expect(updated.macrocycleDate).toEqual(new Date(2026, 0, 19, 0, 0, 0, 0));
  });

  it("can update to a different weekday if specified", () => {
    const prev: MacrocycleDashboard = {
      program: "RPT",
      macrocycleUnit: "Week",
      macrocycleNum: 1,
      macrocycleDate: new Date(2026, 0, 5, 0, 0, 0, 0),
      sheetName: "RPT_Cycle_1_20260105",
      macrocycleStartWeekday: Weekday.Monday,
    };
    const overrides = {
      targetWeekday: "Friday" as Weekday,
      today: new Date(2026, 0, 16, 0, 0, 0, 0),
    };
    const updated = updateMacrocycle(prev, overrides);
    expect(updated.macrocycleNum).toBe(2);
    expect(updated.sheetName).toBe("RPT_Cycle_2_20260116");
    expect(updated.macrocycleDate).toEqual(new Date(2026, 0, 16, 0, 0, 0, 0));
    // Should be a Friday
    const date = new Date(updated.macrocycleDate);
    expect(date.getUTCDay()).toBe(5);
  });

  it("defaults to previous macrocycle's weekday if targetWeekday is not specified", () => {
    const prev: MacrocycleDashboard = {
      program: "RPT",
      macrocycleUnit: "Week",
      macrocycleNum: 2,
      macrocycleDate: new Date(2026, 0, 12, 0, 0, 0, 0), // Monday
      sheetName: "RPT_Cycle_2_20260112",
      macrocycleStartWeekday: Weekday.Monday,
    };
    const overrides = {
      today: new Date(2026, 0, 19, 0, 0, 0, 0),
    };
    const updated = updateMacrocycle(prev, overrides);
    expect(updated.macrocycleNum).toBe(3);
    expect(updated.sheetName).toBe("RPT_Cycle_3_20260119");
    expect(updated.macrocycleDate).toEqual(new Date(2026, 0, 19, 0, 0, 0, 0));
    expect(new Date(updated.macrocycleDate).getUTCDay()).toBe(1); // Monday
  });

  it("handles case-insensitive weekday names", () => {
    const prev: MacrocycleDashboard = {
      program: "RPT",
      macrocycleUnit: "Week",
      macrocycleNum: 3,
      macrocycleDate: new Date(2026, 0, 19, 0, 0, 0, 0), // Monday
      sheetName: "RPT_Cycle_3_20260119",
      macrocycleStartWeekday: Weekday.Monday,
    };
    const overrides = {
      targetWeekday: "friday" as Weekday,
      today: new Date(2026, 0, 23, 0, 0, 0, 0),
    };
    const updated = updateMacrocycle(prev, overrides);
    expect(updated.macrocycleNum).toBe(4);
    expect(updated.sheetName).toBe("RPT_Cycle_4_20260130");
    expect(updated.macrocycleDate).toEqual(new Date(2026, 0, 30, 0, 0, 0, 0));
    expect(new Date(updated.macrocycleDate).getUTCDay()).toBe(5); // Friday
  });

  it("returns correct macrocycleDate even if today is before the next macrocycle", () => {
    const prev: MacrocycleDashboard = {
      program: "RPT",
      macrocycleUnit: "Week",
      macrocycleNum: 4,
      macrocycleDate: new Date(2026, 0, 23, 0, 0, 0, 0), // Friday
      sheetName: "RPT_Cycle_4_20260123",
      macrocycleStartWeekday: Weekday.Friday,
    };
    // Today is before the next Friday
    const overrides = {
      targetWeekday: "Friday" as Weekday,
      today: new Date(2026, 0, 24, 0, 0, 0, 0),
    };
    const updated = updateMacrocycle(prev, overrides);
    expect(updated.macrocycleNum).toBe(5);
    expect(updated.sheetName).toBe("RPT_Cycle_5_20260130");
    expect(updated.macrocycleDate).toEqual(new Date(2026, 0, 30, 0, 0, 0, 0));
    expect(new Date(updated.macrocycleDate).getUTCDay()).toBe(5); // Friday
  });

  it("works with Sunday as the target weekday", () => {
    const prev: MacrocycleDashboard = {
      program: "RPT",
      macrocycleUnit: "Week",
      macrocycleNum: 5,
      macrocycleDate: new Date(2026, 0, 25, 0, 0, 0, 0), // Sunday
      sheetName: "RPT_Cycle_5_20260125",
      macrocycleStartWeekday: Weekday.Sunday,
    };
    const overrides = {
      targetWeekday: "Sunday" as Weekday,
      today: new Date(2026, 1, 1, 0, 0, 0, 0),
    };
    const updated = updateMacrocycle(prev, overrides);
    expect(updated.macrocycleNum).toBe(6);
    expect(updated.sheetName).toBe("RPT_Cycle_6_20260201");
    expect(updated.macrocycleDate).toEqual(new Date(2026, 1, 1, 0, 0, 0, 0));
    expect(new Date(updated.macrocycleDate).getUTCDay()).toBe(0); // Sunday
  });
});
