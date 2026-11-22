import { spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * Issue #1102: getNextDate compared and stepped weekdays in local time, but a
 * macrocycle date is UTC midnight, which west of UTC is the previous evening
 * locally. So on such a host the next macrocycle could start a day off the
 * target weekday.
 *
 * Jest ignores a mid-process `process.env.TZ` change on this repo's Windows
 * setup, so each zone runs in a fresh child process with TZ set at launch
 * (tests/support/getNextDateTzChild.js; the same pattern as
 * distributeWorkouts.timezone.test.ts).
 */
type ChildResult = {
  timezoneOffsetMinutes: number;
  todayIsTarget: string;
  mostRecentTarget: string;
  nextTarget: string;
  defaultWeekday: string;
  updateMacrocycle: { macrocycleDate: string; sheetName: string };
};

function runInZone(tz: string): ChildResult {
  const childScript = path.join(__dirname, "..", "..", "..", "support", "getNextDateTzChild.js");
  const result = spawnSync(process.execPath, [childScript], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `getNextDateTzChild.js exited with status ${String(result.status)} in ${tz}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as ChildResult;
}

const midnight = (ymd: string) => `${ymd}T00:00:00.000Z`;

describe.each<[string, (offset: number) => boolean]>([
  ["America/New_York", (offset) => offset > 0],
  ["America/Los_Angeles", (offset) => offset > 0],
  ["Pacific/Auckland", (offset) => offset < 0],
  ["UTC", (offset) => offset === 0],
])("getNextDate in a %s process (issue #1102)", (tz, offsetMatchesZone) => {
  let result: ChildResult;

  beforeAll(() => {
    result = runInZone(tz);
  });

  it("really runs in that zone", () => {
    // If TZ passthrough ever breaks, the assertions below would pass for the
    // wrong reason; this fails instead.
    expect(offsetMatchesZone(result.timezoneOffsetMinutes)).toBe(true);
  });

  it("returns today when today is the target weekday", () => {
    expect(result.todayIsTarget).toBe(midnight("2026-06-15"));
  });

  it("returns the most recent target weekday", () => {
    expect(result.mostRecentTarget).toBe(midnight("2026-06-15"));
  });

  it("returns the next target weekday at least 7 days after the previous date", () => {
    expect(result.nextTarget).toBe(midnight("2026-05-25"));
  });

  it("defaults the target to the previous date's UTC weekday", () => {
    expect(result.defaultWeekday).toBe(midnight("2026-05-25"));
  });

  it("advances the macrocycle to the target weekday when no date is given", () => {
    expect(result.updateMacrocycle).toEqual({
      macrocycleDate: midnight("2026-06-15"),
      sheetName: "RPT_Cycle_2_20260615",
    });
  });
});
