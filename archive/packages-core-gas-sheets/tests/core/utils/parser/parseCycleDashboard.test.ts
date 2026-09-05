import { parseCycleDashboard, Weekday } from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("parseCycleDashboard", () => {
  it("parses dashboard CSV data into a CycleDashboard object", () => {
    const data = loadCsvFixture("dashboard_20260105.csv");
    const result = parseCycleDashboard(data);
    expect(result).toEqual({
      program: "RPT",
      cycleUnit: "Week",
      cycleNum: 1,
      // UTC midnight of the named day (issue #899) -- `new Date("1/5/2026")`
      // (local midnight) would itself be host-timezone-dependent here and
      // silently pass on any host, since both sides of the old assertion
      // were computed the same locale-dependent way.
      cycleDate: new Date(Date.UTC(2026, 0, 5)),
      sheetName: "RPT_Cycle_1_20260105",
      cycleStartWeekday: Weekday.Monday,
    });
  });

  // Regression for issue #899, same root cause and fix as parseTrainingMaxes.ts
  // (#894): a non-ISO cell like "1/5/2026" parsed via bare `new Date(string)`
  // carried whatever non-midnight local-time offset the host happened to be
  // at, instead of exact UTC midnight.
  it("normalizes cycleDate to UTC midnight regardless of the host timezone", () => {
    const data = loadCsvFixture("dashboard_20260105.csv");
    const result = parseCycleDashboard(data);
    expect(result.cycleDate.getUTCHours()).toBe(0);
    expect(result.cycleDate.getUTCMinutes()).toBe(0);
    expect(result.cycleDate.getUTCSeconds()).toBe(0);
    expect(result.cycleDate.getUTCMilliseconds()).toBe(0);
  });

  // Aligned with parseTrainingMaxes (#356): missing required keys now throw a
  // descriptive error rather than yielding sentinel values ("", NaN, Invalid Date)
  // that pushed failures downstream into renderers.
  it("throws when required keys are missing entirely", () => {
    expect(() => parseCycleDashboard([])).toThrow(/Invalid Program value/);
  });

  it("throws when Cycle # is missing while other required keys are present", () => {
    const data = loadCsvFixture("dashboard_20260105.csv").filter(
      ([key]) => String(key) !== "Cycle #",
    );
    expect(() => parseCycleDashboard(data)).toThrow(/Invalid Cycle # value/);
  });

  it("throws when Cycle Date is unparseable", () => {
    const data = loadCsvFixture("dashboard_20260105.csv").map((row) =>
      String(row[0]) === "Cycle Date" ? [row[0], "not-a-date"] : row,
    );
    expect(() => parseCycleDashboard(data)).toThrow(/Invalid Cycle Date value/);
  });

  it("throws when Cycle # is an empty string (Number coerces empty to 0)", () => {
    const data = loadCsvFixture("dashboard_20260105.csv").map((row) =>
      String(row[0]) === "Cycle #" ? [row[0], ""] : row,
    );
    expect(() => parseCycleDashboard(data)).toThrow(/Invalid Cycle # value/);
  });

  it("throws when Cycle # is zero or negative", () => {
    const data = loadCsvFixture("dashboard_20260105.csv").map((row) =>
      String(row[0]) === "Cycle #" ? [row[0], "0"] : row,
    );
    expect(() => parseCycleDashboard(data)).toThrow(/Invalid Cycle # value/);
  });

  it("throws when Start Weekday is not a valid Weekday enum value", () => {
    const data = loadCsvFixture("dashboard_20260105.csv").map((row) =>
      String(row[0]) === "Start Weekday" ? [row[0], "Funday"] : row,
    );
    expect(() => parseCycleDashboard(data)).toThrow(/Invalid Start Weekday value/);
  });
});
