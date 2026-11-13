# ADR-043: A Lift's Progression Resolves Row, Lift, Default, Catalog, and Is Stored Beside Each

**Status:** Accepted
**Date:** 2026-11-11
**Issue:** [#1210](https://github.com/merickvaughn/lifting-logbook/issues/1210) (top-level [#1206](https://github.com/merickvaughn/lifting-logbook/issues/1206))
**Related:** [Progression Type per Lift proposal](../proposals/2026-11-10-lift-progression-types.md), [ADR-041](ADR-041-lift-modification-storage.md) (`lift_metadata`-style per-user lift rows), [ADR-039](ADR-039-focus-block-persistence.md) (focus blocks, which share the vocabulary)

---

## Context

Every lift is getting a **progression type** (`linear`, `double`, `amrap_gated`, `percent_wave`,
`manual`; `rpe` only for focus blocks until per-set RPE logging exists), with an increment and, where
the type needs one, a rep range. The owner's decisions are recorded in the proposal. Phase 1
([#1209](https://github.com/merickvaughn/lifting-logbook/issues/1209)) added the shared enum, a
catalog default on each built-in lift, and a pure `resolveProgression` that nothing calls yet. This
phase stores the values a lifter sets and exposes them. Phase 3
([#1211](https://github.com/merickvaughn/lifting-logbook/issues/1211)) makes `updateMaxes` dispatch on
the result.

Two things needed recording: which value applies when several are set, and where each is stored.
Every existing program must keep progressing exactly as it does today.

## Decision

1. **The type and rep range come from the first of five sources that names a type:** the program's
   spec row, the lift's own value, the lifter's default, the built-in lift's catalog default, then
   `amrap_gated` with no range. A source supplies its type and range together, so a spec row that
   names no type takes its range from the lift or default along with the type, while the row's
   `reps` stays the target inside the program. `resolveProgression` in
   `packages/core/src/services/maxes/resolveProgression.ts` is the one implementation.

2. **The increment resolves on its own.** Inside a program the spec row's required `increment`
   always applies, whatever source supplied the type. Off-program it is the lift's own increment,
   then the default's, then `defaultWeightIncrement`. The catalog carries none.

3. **A lift's own value is four nullable columns on `lift_metadata`:** `progression`,
   `progressionIncrement`, `repsLow`, `repsHigh`. The table already holds one row per user per lift,
   built-in or custom, so Manage Lifts can set a value on any lift, and the columns inherit the
   table's forced row-level security [1]. A null type falls through to the default.

4. **The lifter's default is four nullable columns on `user_settings`:** `defaultProgression` and
   its increment and range. Unset means the catalog applies. The API reads and writes it as one
   object, `{ type, increment, repsLow, repsHigh }` or `null`, and a write replaces all four columns,
   so a new default never keeps a stale range from the one it replaced.

5. **A spec row's override is `progression` and `repsLow` on `custom_program_spec` and
   `LiftingProgramSpec`.** The row's `reps` is the top of its range. Built-in presets tag every row
   `amrap_gated` in code. A second migration tags every existing `custom_program_spec` row
   `amrap_gated` with an `UPDATE ... WHERE progression IS NULL` [3]. A new row may leave it null to
   follow the lift. The program editor carries both fields through an edit, because saving replaces
   every row, and a spec import writes them only when the row has them, so a re-import never clears
   the backfilled value.

6. **Values are checked in the DTOs and guarded on read, not by CHECK constraints.** The DTOs reject
   an unknown type, `rpe` anywhere a lift's progression is set, a non-positive increment, and a
   bottom above the top, with a 400. A patch that sends one end of a lift's range is checked against
   the stored other end. On read, an adapter treats an unknown stored type as unset, as
   `user_settings.unit` already does.

## Alternatives considered

- **A column on `custom_lift` only** (the owner's first answer). Built-in lifts have no row there, so
  a lifter couldn't give Squat its own type. The owner revised this to `lift_metadata` (decision 14).
- **The default as one JSON column.** It would need its own read-side shape check and gains nothing:
  the four values are fixed scalars like the other settings columns.
- **A column default of `amrap_gated` on `custom_program_spec`.** It would tag new rows too, so a
  lifter could never leave a row blank to follow the lift. Backfilling only the existing rows keeps
  today's behaviour without that.
- **Leaving existing custom rows null.** Then a lifter who set their default to `linear` would
  silently change how an existing custom program progresses, which the proposal rules out.
- **CHECK constraints on the type and range.** Consistent with nothing else in this schema, and the
  same rules must live in the DTOs anyway to answer with a 400.

## Consequences

- The backfill is its own migration (`20261111000001_backfill_custom_spec_progression`) so the db
  e2e suite can run the shipped SQL against seeded rows. It is idempotent.
- A custom program the old API revision saves between the migration and the new revision going live
  writes null, so it follows the lift like a row left blank. The window lasts one rollout, and
  nothing reads the column until #1211.
- Saving a custom program keeps a row's stored `progression` and `repsLow` when the request leaves
  them out, and clears them only on an explicit null. A web bundle that predates the fields, still
  open in a tab after the deploy, therefore can't undo the backfill.
- The new web sends the progression fields, which the old API rejects as unknown. Roll the web back
  with the API, or before it.
- Until #1211 lands, the stored values change nothing: no code path moves a max by them. (It has
  landed: see the amendment below.)
- The mobile app doesn't expose either setting yet (out of scope in the proposal).
- Adding the columns rewrites no table: each is nullable with no default [2].

## Amendment: dispatch and the plan (#1211, 2026-11-12)

Phase 3 ([#1211](https://github.com/merickvaughn/lifting-logbook/issues/1211)) reads the stored values.
`updateMaxes` dispatches on the resolved type, and the workout logger plans by it. The type rules are
the proposal's. These details weren't settled there:

1. **The API passes the lifter's settings; a caller without them gets the old behaviour.** The
   option carries `lift_metadata`, the default, `defaultWeightIncrement` and the custom lifts (a
   custom lift named like a catalog lift has no catalog default, as `lookupLift` reads it). A lift
   finds its `lift_metadata` row with `lookupByLift`, so another spelling of it counts; the logger
   reads every row through `GET /lifts/metadata` and finds it the same way. Without
   it, only a row's own `progression` counts and a lift with no spec row is skipped as
   `no-program-spec`. That keeps every existing caller and test on the old rule. The rejected
   alternative was to always fall back to the catalog, which turns a test row with no type into
   `linear` for Squat.
2. **Test weeks and deloads stay the same for every type, `manual` included.** A test week takes the
   best final set whatever the type, since the lifter chose the load there too. No set in a deload
   moves a max.
3. **A `percent_wave` wave ends in the last spec week that plans the lift, once per pass** through
   the spec's weeks, and the max moves once per pass. A deload ending a wave still ends it; a test
   week ending it sets the max by its attempt and adds no increment. A pass bumps a max older than
   the first set that ends it, dated at the last, so a recalculation midway through that week and
   another after it move the max once. Requiring the program's very last workout, or the spec's
   last week, was rejected: a lift that day or week doesn't plan would never move.
4. **`linear` and `double` share one rule:** every set of the session meets the target, and inside a
   program at least the row's `sets` were logged. The new max is set 1's weight plus the increment.
5. **A stored rep range whose bottom is above its top reads as unset** (`storedLiftProgression`). The
   PATCH endpoint checks a one-end patch against the stored other end in a separate read, so two
   overlapping patches can store a crossed range.
6. **The logger, the detail page and the timer plan `double` flat at the max**, at the bottom of the range when the max moved on or
   after the lift's last session, otherwise at last session's reps. The last session comes from the
   current macrocycle's records, so a macrocycle's first session plans the bottom. From an own max it
   plans the bottom, since the lift's last session doesn't date that max. A lift with no spec row on
   `linear` or `amrap_gated` plans three sets of its `repsHigh` at its max. In a workout dated before
   today that logged it, it keeps only its logged sets, so a finished workout stays read-only. A failed settings read resolves each
   lift from its row and the catalog, and a failed records read plans `double` without a last
   session. All three load the plan through `loadProgressionPlans`, so they agree
   ([#1249](https://github.com/merickvaughn/lifting-logbook/issues/1249)); the detail page and the
   timer read the lifter's custom lifts for it through the same bounded read the timer classifies
   with, so a slow read holds the page for that budget at most. A failed or slow custom-lift read
   there resolves every lift as a built-in instead of failing the settings read, so during such an
   outage a custom lift named like a catalog one plans by the catalog's default on those pages.

## Amendment: the last session comes with the workout (#1252, 2026-11-13)

Point 6's last session was found by the web from `GET /lift-records`, the whole current
macrocycle's records, fetched after the settings read whenever a lift resolved to `double`. That
added a serial round trip, a row-level-security transaction and hundreds of rows of JSON to the
logger, the detail page and the timer, the fetch [#978](https://github.com/merickvaughn/lifting-logbook/issues/978)
had removed from the logger.

`GET /programs/:program/workouts/:n` now returns each lift's `lastSession` (its date and each
set's reps, by set number), read in the workout's own transaction by
`ILiftRecordRepository.getLastSessions`: one grouped query finds each lift's latest earlier session,
and a second reads that session's sets. The rule is point 6's: another workout in the current
macrocycle dated on or before this one (its rescheduled date when it has one), under any spelling
of the lift, counting only the lift's first occurrence. Two workouts on the same date resolve to the
higher-numbered one, where the web's read left it to record order. `loadProgressionPlans` reads the
field for a `double` lift and makes no request of its own.

Two behaviours change with the move:

- **A failed read fails the workout read.** This replaces point 6's "a failed records read plans
  `double` without a last session". The read runs inside the request's row-level-security
  transaction, where a failed statement aborts the transaction. Catching it and carrying on would
  either fail the commit or roll back a macrocycle row the response had already named. So it fails
  the way the workout's other queries do.
- **A program with no macrocycle dashboard** reads the macrocycle `currentMacrocycleOrFirst` falls
  back to, as the rest of the workout does. `GET /lift-records` returned 404 there, so the web
  planned `double` from the bottom of the range. Now sets logged in that macrocycle count.

The API reads last sessions for every lift on every workout read, since it doesn't resolve
progression types. That includes reads that never plan, such as the manage-lifts pages. Rejected: a
dedicated endpoint the web calls only for `double` lifts, which would keep a serial round trip and
a transaction on those renders.

## References

1. PostgreSQL 16 documentation, [§5.8 Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) — policies apply per row, so new columns on `lift_metadata`, `user_settings` and `custom_program_spec` inherit them.
2. PostgreSQL 16 documentation, [`ALTER TABLE`, Notes](https://www.postgresql.org/docs/16/sql-altertable.html#SQL-ALTERTABLE-NOTES) — adding a column with no default doesn't rewrite the table.
3. PostgreSQL 16 documentation, [`UPDATE`](https://www.postgresql.org/docs/16/sql-update.html) — the backfill touches only rows whose `progression` is null, so a second run changes nothing.
4. Prisma documentation, [Customizing migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations) — a hand-written data migration alongside the generated schema change.
5. class-validator, [Validation decorators](https://github.com/typestack/class-validator#validation-decorators) and [Custom validation classes](https://github.com/typestack/class-validator#custom-validation-classes) — `@IsIn`, `@IsOptional` (which skips `null` as well as `undefined`), and the `IsAtMostSibling` cross-field constraint.
6. Prisma documentation, [Aggregation, grouping, and summarizing → Group by](https://www.prisma.io/docs/orm/prisma-client/queries/aggregation-grouping-summarizing#group-by) — `groupBy` runs as SQL `GROUP BY`, so the amendment's first query returns one row per session, not per set.
