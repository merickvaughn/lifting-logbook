# Archive: Google-Sheets-era `packages/core` grid and mapper code

**Archived:** 2026-09-04 — [#979](https://github.com/merickvaughn/lifting-logbook/issues/979)
**Last live commit:** tag `sheets-era-core-complete` (the parent of the commit that moved these files)
**Status:** frozen. Nothing in the monorepo imports from this directory, and nothing builds, lints, or tests it.

## What this is

`packages/core` began life as the domain layer of a Google Apps Script logbook that read and
wrote workout grids in Google Sheets. When the REST API and the web client replaced that
pipeline, the grid builders, sheet mappers, and dashboard-sheet parser lost their only callers
but stayed in the barrel — 711 lines (13.6% of the package) that loaded into every Jest worker
and every server module graph. `generateLiftPlan` still emits literal `=INDEX(` / `=MROUND(`
formula strings, and 12 of core's 14 `console.log` calls lived here.

The owner chose to **archive rather than delete** so the code stays browsable in the tree.
It lives at the repo root on purpose: `archive/` is outside every npm workspace glob
(`packages/*`, `apps/*`, `tools/*`), outside `packages/core/tsconfig.json`'s `include`,
outside `eslint src`, and outside Jest's per-workspace roots — so it costs nothing to keep
and needed no config edits (in particular no `testPathIgnorePatterns`).

## Path map (old → new)

| Was | Now |
|---|---|
| `packages/core/src/services/workout/{extractLiftRecords,calculateLiftWeights,updateLiftDates,generateLiftPlan,createGridV2,findWorkoutRowsToHideOnEdit,generateLiftSpec}.ts` | `src/services/workout/` |
| `packages/core/src/utils/parser/parseCycleDashboard.ts` | `src/utils/parser/` |
| `packages/core/src/utils/mapper/{mapCycleDashboard,mapLiftingProgramSpec,mapTrainingMaxes,mapLiftRecords}.ts` | `src/utils/mapper/` |
| Sheet keys + header constants from `packages/core/src/constants/config.ts`; `LiftRecordRequiredKeys` from `packages/core/src/models/LiftRecord.ts` | `src/constants/sheets-config.ts` |
| `packages/core/tests/core/services/workout/*.test.ts` (7), `tests/core/utils/mapper/*.test.ts` (4), `tests/core/utils/parser/parseCycleDashboard.test.ts` | `tests/core/…` (same layout) |
| `packages/core/tests/fixtures/{rpt_week_1_20260105,rpt_week_1_20260105_err,rpt_week_1_20260105_err_2,dashboard_20260105}.csv` | `tests/fixtures/` |

Three shared test helpers were **pruned, not moved**: `tests/testUtils.ts` (kept `loadCsvFixture`;
the rest mocked a `@src/api` module that no longer exists), `tests/support/aheadOfUtcChild.js`
and `tests/core/utils/parser/dateParsing.aheadOfUtc.test.ts` (dropped only the
`parseCycleDashboard` case; the `parseLiftRecords` / `parseTrainingMaxes` / `parseStrengthGoals`
cases from #894 / #899 are unchanged).

What stayed in `packages/core` because it is still live: `SpreadsheetCell`, the CSV parsers
(`parseLiftRecords`, `parseTrainingMaxes`, `parseLiftingProgramSpec`, `parseStrengthGoals`,
`parseCsvText`, `tableToObjects`), `updateCycle`, `CycleDashboard`, `Weekday`,
`WARMUP_BASE_REPS`, `PROG_SPEC_*`, `MROUND`, `floorToIncrement`, and the `rpt_program_spec_*`
fixtures shared with `updateMaxes` and the timer tests.

## Resurrecting something

The files import through `@src/core/*` aliases and relative paths that only resolve inside
`packages/core`. To bring one back: `git mv` it to its old path, re-add its `export *` line to
the matching `index.ts`, restore any constant it needs from `sheets-config.ts`, and move its test
back under `packages/core/tests`. `git show sheets-era-core-complete:<old path>` shows the file
exactly as it last compiled.
