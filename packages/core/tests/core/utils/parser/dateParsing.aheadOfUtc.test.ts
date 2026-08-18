import { spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * Regression tests for a host genuinely ahead of UTC -- originally issue
 * #894 (parseLiftRecords / parseTrainingMaxes), extended for issue #899
 * (parseCycleDashboard / parseStrengthGoals): same bug class (bare
 * `new Date(string)` on a non-ISO cell), same fix (parseDateStringUTC +
 * toUTCMidnight) at every call site.
 *
 * jsUtil.test.ts's `parseDateStringUTC` unit tests already prove the parsing
 * logic itself is host-timezone-independent by construction (it only ever
 * builds dates via `Date.UTC`), which is sufficient to catch a regression to
 * that HELPER on any non-UTC-offset host -- including this repo's dev/CI
 * machines, today, for real. But `toUTCMidnight(...)` wrapping at each call
 * site makes old-buggy and new-fixed code produce IDENTICAL output on any
 * host that isn't ITSELF ahead of UTC (truncating either the correct instant
 * or the wrong-hour instant down to midnight of their shared UTC calendar
 * day yields the same result) -- so a call site quietly reverting to bare
 * `new Date(string)` while leaving the well-tested helper untouched would be
 * invisible to any assertion that doesn't run ahead of UTC for real.
 *
 * Mutating `process.env.TZ` mid-test does not reliably achieve that here:
 * Jest caches host timezone data before test code runs, so a `beforeEach`
 * that sets `process.env.TZ` is silently a no-op in this repo's Jest/Windows
 * setup (confirmed empirically -- a canary assertion relying on it failed).
 * Setting TZ at process-launch time in a genuinely fresh child process IS
 * reliably respected, so that's what this file does: a single `beforeAll`
 * spawns tests/support/aheadOfUtcChild.js (a plain-JS worker -- see that
 * file for why it isn't itself a spawned Jest/ts-jest process) once, with
 * TZ=Pacific/Auckland set in the child's environment, and both describe
 * blocks below assert on the real parser results it reports back --
 * one spawn covers all four parsers rather than spawning per issue (a
 * finding from /review on PR #903: two independent per-block spawns of the
 * same script duplicated boilerplate and doubled process-launch cost for no
 * benefit, since neither block's assertions depend on the other's).
 */
type DateParts = { year: number; month: number; date: number; hours: number };
type AheadOfUtcResult = {
  timezoneOffsetMinutes: number;
  liftRecordDate: DateParts;
  trainingMaxDate: DateParts;
  cycleDashboardDate: DateParts;
  strengthGoalUpdatedAt: DateParts;
};

let parsed: AheadOfUtcResult;

beforeAll(() => {
  const childScript = path.join(__dirname, "..", "..", "..", "support", "aheadOfUtcChild.js");
  const result = spawnSync(process.execPath, [childScript], {
    env: { ...process.env, TZ: "Pacific/Auckland" },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `aheadOfUtcChild.js exited with status ${String(result.status)}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }

  parsed = JSON.parse(result.stdout) as AheadOfUtcResult;
});

describe("parseLiftRecords / parseTrainingMaxes on a host ahead of UTC (issue #894)", () => {
  it("resolve M/D/YYYY cells to the UTC calendar day the cell names, in a real Pacific/Auckland process", () => {
    // Sanity check: confirm the child process is actually configured ahead
    // of UTC. getTimezoneOffset() is negative for zones ahead of UTC. If
    // this ever fails, the assertions below aren't proving what this test
    // claims to prove (e.g. TZ passthrough silently broke).
    expect(parsed.timezoneOffsetMinutes).toBeLessThan(0);

    // The bug: on a host ahead of UTC, the OLD code resolved "12/16/2025" to
    // Dec 15 (parseLiftRecords) or Dec 15 at a non-midnight hour
    // (parseTrainingMaxes, which had no toUTCMidnight at all). Confirmed
    // live during development of this test by running this exact script
    // against the pre-fix source.
    expect(parsed.liftRecordDate).toEqual({ year: 2025, month: 11, date: 16, hours: 0 });
    expect(parsed.trainingMaxDate).toEqual({ year: 2025, month: 11, date: 16, hours: 0 });
  });
});

describe("parseCycleDashboard / parseStrengthGoals on a host ahead of UTC (issue #899)", () => {
  it("resolve M/D/YYYY cells to the UTC calendar day the cell names, in a real Pacific/Auckland process", () => {
    // Sanity check (see the identical check in the #894 describe block above).
    expect(parsed.timezoneOffsetMinutes).toBeLessThan(0);

    // The bug: on a host ahead of UTC, the OLD code (bare `new Date(string)`,
    // no UTC normalization at either call site) resolved "1/5/2026" /
    // "6/9/2026" to the PREVIOUS UTC calendar day at a non-midnight hour.
    // Confirmed live during development of this test by running this exact
    // script against the pre-fix source.
    expect(parsed.cycleDashboardDate).toEqual({ year: 2026, month: 0, date: 5, hours: 0 });
    expect(parsed.strengthGoalUpdatedAt).toEqual({ year: 2026, month: 5, date: 9, hours: 0 });
  });
});
