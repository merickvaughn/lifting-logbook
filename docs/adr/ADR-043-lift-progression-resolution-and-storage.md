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
- Until #1211 lands, the stored values change nothing: no code path moves a max by them.
- The mobile app doesn't expose either setting yet (out of scope in the proposal).
- Adding the columns rewrites no table: each is nullable with no default [2].

## References

1. PostgreSQL 16 documentation, [§5.8 Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) — policies apply per row, so new columns on `lift_metadata`, `user_settings` and `custom_program_spec` inherit them.
2. PostgreSQL 16 documentation, [`ALTER TABLE`, Notes](https://www.postgresql.org/docs/16/sql-altertable.html#SQL-ALTERTABLE-NOTES) — adding a column with no default doesn't rewrite the table.
3. PostgreSQL 16 documentation, [`UPDATE`](https://www.postgresql.org/docs/16/sql-update.html) — the backfill touches only rows whose `progression` is null, so a second run changes nothing.
4. Prisma documentation, [Customizing migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations) — a hand-written data migration alongside the generated schema change.
5. class-validator, [Validation decorators](https://github.com/typestack/class-validator#validation-decorators) and [Custom validation classes](https://github.com/typestack/class-validator#custom-validation-classes) — `@IsIn`, `@IsOptional` (which skips `null` as well as `undefined`), and the `IsAtMostSibling` cross-field constraint.
