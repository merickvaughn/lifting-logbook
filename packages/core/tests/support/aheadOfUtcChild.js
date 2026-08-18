"use strict";
/**
 * Plain-JS child-process worker for the "on a host ahead of UTC" regression
 * tests in dateParsing.aheadOfUtc.test.ts -- originally written for issue
 * #894 (parseLiftRecords / parseTrainingMaxes), extended for issue #899
 * (parseCycleDashboard / parseStrengthGoals): same bug class (bare
 * `new Date(string)` on a non-ISO cell), same fix (parseDateStringUTC +
 * toUTCMidnight) at every call site, so one shared child process reports on
 * all four.
 *
 * WHY THIS EXISTS: mutating `process.env.TZ` mid-process is NOT reliably
 * respected inside a Jest worker on this repo's Windows/Node setup (V8
 * caches host timezone data before test code runs, so a `beforeEach` that
 * sets `process.env.TZ` is silently a no-op -- confirmed empirically while
 * writing this test). Setting TZ at process-launch time in a genuinely fresh
 * child process IS reliably respected. This script is that child.
 *
 * WHY IT'S PLAIN JAVASCRIPT, NOT A SPAWNED JEST/TS-JEST PROCESS: two other
 * approaches were tried and rejected during development of this test:
 *   - Spawning `jest`'s own CLI as the child: works, but couples this test
 *     to Jest CLI flag names, which are NOT stable across majors (this
 *     repo's installed Jest 30 renamed --testPathPattern to
 *     --testPathPatterns mid-investigation).
 *   - Running a real `npm run build` first and requiring the compiled
 *     `dist/` output: works and has no version coupling, but adds ~18s to
 *     what is otherwise a ~5s test suite, on every `npm test` invocation.
 * This script instead registers a minimal, single-file transpile-on-require
 * hook (via the `typescript` package, already a devDependency) for just the
 * handful of source files it needs, and a small path-alias resolver
 * mirroring packages/core/tsconfig.json's `@src/core` alias. No new
 * dependencies, no CLI coupling, no full build.
 *
 * Deliberately NOT named `*.test.ts` / `*.test.js` -- Jest's own
 * `testMatch` never picks this file up, so it can't run as (or be mistaken
 * for) a test in its own right; it only ever runs as a spawned child.
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const ts = require("typescript");

const CORE_SRC = path.join(__dirname, "..", "..", "src");

// Resolve the `@src/core` / `@src/core/*` path alias packages/core/tsconfig.json
// declares -- the same alias parseLiftRecords.ts and parseTrainingMaxes.ts use
// for their real imports (e.g. `@src/core/constants`).
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
  if (request === "@src/core") {
    return originalResolveFilename.call(this, path.join(CORE_SRC, "index.ts"), parent, isMain, options);
  }
  if (request.startsWith("@src/core/")) {
    const sub = request.slice("@src/core/".length);
    return originalResolveFilename.call(this, path.join(CORE_SRC, sub), parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Minimal transpile-on-require for .ts: single-file syntactic transpile only
// (no type-checking -- this is a test harness, not a build), mirroring this
// repo's tsconfig.base.json `module`/`esModuleInterop` settings.
require.extensions[".ts"] = function transpileAndCompile(mod, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  mod._compile(outputText, filename);
};

const { parseLiftRecords } = require(path.join(CORE_SRC, "utils", "parser", "parseLiftRecords.ts"));
const { parseTrainingMaxes } = require(path.join(CORE_SRC, "utils", "parser", "parseTrainingMaxes.ts"));
const { parseCycleDashboard } = require(path.join(CORE_SRC, "utils", "parser", "parseCycleDashboard.ts"));
const { parseStrengthGoals } = require(path.join(CORE_SRC, "utils", "parser", "parseStrengthGoals.ts"));

// Same fixture shape as parseLiftRecords.test.ts's / parseTrainingMaxes.test.ts's
// own "normalizes ... regardless of host timezone" tests -- a non-ISO M/D/YYYY
// cell, the common case in this app's real CSV exports.
const [record] = parseLiftRecords([
  ["Program", "Cycle #", "Workout #", "Date", "Lift", "Set #", "Weight", "Reps", "Notes"],
  ["5-3-1", "1", "1", "12/16/2025", "Bench P.", "1", "180", "5", ""],
]);
const [trainingMax] = parseTrainingMaxes([
  ["Date Updated", "Lift", "Weight"],
  ["12/16/2025", "Bench", "150"],
]);

// Mirrors tests/fixtures/dashboard_20260105.csv (Cycle Date: "1/5/2026").
const cycleDashboard = parseCycleDashboard([
  ["Program", "RPT"],
  ["Cycle Unit", "Week"],
  ["Cycle #", "1"],
  ["Cycle Date", "1/5/2026"],
  ["Sheet Name", "RPT_Cycle_1_20260105"],
  ["Start Weekday", "Monday"],
]);

// Mirrors tests/fixtures/strength_goals.csv (Today's Date: "6/9/2026").
const [strengthGoal] = parseStrengthGoals([
  ["Weight", "175", "", "", ""],
  ["Start Date", "10/24/2022", "", "", ""],
  ["Today's Date", "6/9/2026", "", "", ""],
  ["Lift", "Current TM", "Intermediate", "Advanced", "Elite"],
  ["Squat", "250", "280", "350", "420"],
]);

const describeDate = (d) => ({
  year: d.getUTCFullYear(),
  month: d.getUTCMonth(),
  date: d.getUTCDate(),
  hours: d.getUTCHours(),
});

process.stdout.write(
  JSON.stringify({
    // Negative for a host ahead of UTC (e.g. Pacific/Auckland) -- a sanity
    // check that this process is actually configured the way the test
    // claims, so a broken TZ passthrough fails loudly instead of the
    // assertions below trivially passing for the wrong reason.
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    liftRecordDate: describeDate(record.date),
    trainingMaxDate: describeDate(trainingMax.dateUpdated),
    cycleDashboardDate: describeDate(cycleDashboard.cycleDate),
    strengthGoalUpdatedAt: describeDate(strengthGoal.updatedAt),
  }),
);
