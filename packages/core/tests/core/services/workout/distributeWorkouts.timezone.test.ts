import { spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * Issue #1031: on a host west of UTC, a macrocycle starting on a Monday had its
 * scheduled workouts dated a week early. The macrocycle date is UTC midnight,
 * which west of UTC is the previous evening locally, so aligning to Monday in
 * local time backed up to the Monday before.
 *
 * Jest ignores a mid-process `process.env.TZ` change on this repo's Windows
 * setup, so each zone runs in a fresh child process with TZ set at launch
 * (tests/support/distributeWorkoutsTzChild.js; the same pattern as
 * dateParsing.aheadOfUtc.test.ts).
 */
type ChildResult = {
  timezoneOffsetMinutes: number;
  mondayStart: string[];
  wednesdayStart: string[];
  acrossDstChange: string[];
};

function runInZone(tz: string): ChildResult {
  const childScript = path.join(__dirname, "..", "..", "..", "support", "distributeWorkoutsTzChild.js");
  const result = spawnSync(process.execPath, [childScript], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `distributeWorkoutsTzChild.js exited with status ${String(result.status)} in ${tz}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as ChildResult;
}

const midnight = (ymd: string) => `${ymd}T00:00:00.000Z`;

describe.each<[string, (offset: number) => boolean]>([
  ["America/Los_Angeles", (offset) => offset > 0],
  ["Pacific/Auckland", (offset) => offset < 0],
  ["UTC", (offset) => offset === 0],
])("distributeWorkouts in a %s process (issue #1031)", (tz, offsetMatchesZone) => {
  let result: ChildResult;

  beforeAll(() => {
    result = runInZone(tz);
  });

  it("really runs in that zone", () => {
    // If TZ passthrough ever breaks, the assertions below would pass for the
    // wrong reason; this fails instead.
    expect(offsetMatchesZone(result.timezoneOffsetMinutes)).toBe(true);
  });

  it("schedules a Monday macrocycle's first workout on that Monday, at UTC midnight", () => {
    expect(result.mondayStart).toEqual(["2026-05-18", "2026-05-20", "2026-05-22"].map(midnight));
  });

  it("aligns a mid-week start to the Monday of the same week", () => {
    expect(result.wednesdayStart).toEqual(["2026-05-18", "2026-05-20", "2026-05-22"].map(midnight));
  });

  it("keeps whole calendar days across the 2026-03-08 US daylight-saving change", () => {
    expect(result.acrossDstChange).toEqual(
      ["2026-03-02", "2026-03-04", "2026-03-06", "2026-03-09", "2026-03-11", "2026-03-13"].map(midnight),
    );
  });
});
