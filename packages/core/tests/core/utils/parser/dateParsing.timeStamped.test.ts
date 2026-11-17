import { spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * A text date with a time part (`M/D/YYYY HH:MM[:SS]`) parses to the UTC day
 * the text names, on a host behind UTC (#1316). The parser runs in a child
 * process launched with TZ=America/New_York, because Jest ignores a TZ change
 * made mid-process (see dateParsing.aheadOfUtc.test.ts and CLAUDE.md).
 */
type Result = { timezoneOffsetMinutes: number; epochArtefact: string; morningSession: string };

let parsed: Result;

beforeAll(() => {
  const childScript = path.join(__dirname, "..", "..", "..", "support", "timeStampedDateChild.js");
  const result = spawnSync(process.execPath, [childScript], {
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `timeStampedDateChild.js exited with status ${String(result.status)}.\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  parsed = JSON.parse(result.stdout) as Result;
});

describe("parseDateStringUTC on a time-stamped text date in America/New_York (#1316)", () => {
  it("runs in a host behind UTC", () => {
    expect(parsed.timezoneOffsetMinutes).toBeGreaterThan(0);
  });

  it("reads 12/31/1969 19:00:00 as 1969-12-31 UTC midnight", () => {
    expect(parsed.epochArtefact).toBe("1969-12-31T00:00:00.000Z");
  });

  it("reads 11/9/2026 07:30:00 as 2026-11-09 UTC midnight", () => {
    expect(parsed.morningSession).toBe("2026-11-09T00:00:00.000Z");
  });
});
