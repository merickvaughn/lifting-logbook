import { parseTrainingMaxes } from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("parseTrainingMaxes", () => {
  it("converts training_maxes.csv to array of objects", () => {
    const data = loadCsvFixture("training_maxes.csv");
    const result = parseTrainingMaxes(data);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!).toHaveProperty("dateUpdated");
    // Should be a Date object
    expect(result[0]!.dateUpdated).toBeInstanceOf(Date);
    expect(result[0]!).toHaveProperty("lift");
    expect(result[0]!).toHaveProperty("weight");
  });

  it("parses weight as a number", () => {
    const data = [
      ["Date Updated", "Lift", "Weight"],
      ["2024-01-01", "Squat", "200"],
    ];
    const result = parseTrainingMaxes(data);
    expect(typeof result[0]!.weight).toBe("number");
    expect(result[0]!.weight).toBe(200);
  });

  it("parses dateUpdated as a Date object", () => {
    const data = [
      ["Date Updated", "Lift", "Weight"],
      ["2024-01-01", "Bench", "150"],
    ];
    const result = parseTrainingMaxes(data);
    expect(result[0]!.dateUpdated).toBeInstanceOf(Date);
    expect(result[0]!.dateUpdated.toISOString().startsWith("2024-01-01")).toBe(
      true,
    );
  });

  it("handles empty data gracefully", () => {
    const data: any[][] = [];
    const result = parseTrainingMaxes(data);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it("throws error for missing required fields", () => {
    const data = [
      ["Date Updated", "Lift"],
      ["2024-01-01", "Deadlift"],
    ];
    expect(() => parseTrainingMaxes(data)).toThrow();
  });

  // Regression for issue #894: this call site previously had NO toUTCMidnight
  // normalization at all, so a non-ISO cell like "12/29/2025" carried
  // whatever non-midnight local-time offset the host happened to be at
  // (e.g. T05:00:00.000Z on an America/New_York host) instead of exact UTC
  // midnight. updateMaxes.ts compares dateUpdated against LiftRecord.date
  // (which parseLiftRecords.ts DOES normalize) via getTime(), so the two
  // parsers silently disagreeing broke that comparison on any non-UTC host --
  // confirmed live by updateMaxes.test.ts, which failed on this exact
  // machine's timezone before this fix.
  it("normalizes a parsed date to UTC midnight regardless of the host timezone", () => {
    const data = [
      ["Date Updated", "Lift", "Weight"],
      ["12/29/2025", "Bench", "150"],
    ];
    const [result] = parseTrainingMaxes(data);
    expect(result?.dateUpdated.getUTCHours()).toBe(0);
    expect(result?.dateUpdated.getUTCMinutes()).toBe(0);
    expect(result?.dateUpdated.getUTCSeconds()).toBe(0);
    expect(result?.dateUpdated.getUTCMilliseconds()).toBe(0);
  });

  // Regression for issue #894, same root cause as parseLiftRecords.test.ts's
  // analogous comment above: this call site previously had no toUTCMidnight
  // normalization at all (unlike parseLiftRecords.ts, which #892 already
  // partially normalized), so a non-ISO cell like "12/16/2025" both landed on
  // the wrong UTC calendar day AND carried a non-midnight time-of-day on any
  // host ahead of UTC. Proving the day-selection half requires an actual
  // ahead-of-UTC process -- see dateParsing.aheadOfUtc.test.ts, which spawns
  // one and exercises this exact fixture through the real parseTrainingMaxes.
});
