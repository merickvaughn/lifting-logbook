import { parseLiftRecords } from "@src/core";
import { loadCsvFixture } from "../../../testUtils";

describe("parseLiftRecords", () => {
  it("parses lift records from fixture data", () => {
    const data = loadCsvFixture("lift_records.csv");
    const records = parseLiftRecords(data);
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]!).toHaveProperty("program");
    expect(records[0]!).toHaveProperty("cycleNum");
    expect(records[0]!).toHaveProperty("workoutNum");
    expect(records[0]!).toHaveProperty("setNum");
  });

  // Regression for issue #884: LiftRecord.date now joins the natural key,
  // which encodes it as a UTC calendar day and reconstructs UTC midnight when
  // parsing a key/id back apart. A non-ISO date cell like "12/16/2025" parses
  // at LOCAL midnight (ECMA-262), which is only UTC midnight on a UTC host —
  // on any other host the stored date must still normalize to UTC midnight or
  // the record becomes unreachable by a later PATCH/undo.
  it("normalizes a parsed date to UTC midnight regardless of the host timezone", () => {
    const data = [
      ["Program", "Cycle #", "Workout #", "Date", "Lift", "Set #", "Weight", "Reps", "Notes"],
      ["5-3-1", "1", "1", "12/16/2025", "Bench P.", "1", "180", "5", ""],
    ];
    const [record] = parseLiftRecords(data);
    expect(record?.date.getUTCHours()).toBe(0);
    expect(record?.date.getUTCMinutes()).toBe(0);
    expect(record?.date.getUTCSeconds()).toBe(0);
    expect(record?.date.getUTCMilliseconds()).toBe(0);
  });
});
