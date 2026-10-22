# ADR-038: Training-Time Vocabulary — Macrocycle and Mesocycle

**Status:** Accepted
**Date:** 2026-10-09
**Issue:** [#1038](https://github.com/merickvaughn/lifting-logbook/issues/1038) (sub-issues [#1039](https://github.com/merickvaughn/lifting-logbook/issues/1039), [#1040](https://github.com/merickvaughn/lifting-logbook/issues/1040))
**Related:** [`docs/glossary.md`](../glossary.md) (the term map), [`docs/domain-model.md`](../domain-model.md) §3 (how each level is stored)

---

## Context

The code called one full run through a program a **cycle** (`cycleNum`, `cycle_dashboard`,
`/cycle/<n>`). For 5/3/1 that is 12 weeks: four 3-week blocks. It called the repeating block a
**block** (`blockWeeks`) and labeled it **"Wave N"** on the plan page.

Lifters use "cycle" for both spans. Wendler's 5/3/1 "cycle" is the 4-week block, three work weeks
plus a deload. Juggernaut's and Smolov's "cycle" is the whole 13–16-week program. The app
contradicted itself the same way:

- The 5/3/1 catalog card described a 4-week cycle with a Week-4 deload.
- The dashboard headed a 12-week, deload-free span "Cycle 1".
- The user guide promised a phase breakdown ("loading, hypertrophy, deload, testing") that the
  code never produced.
- Some import errors printed raw field names (`cycleNum is not a number`).
- Nothing in the app explained any of these terms.

## Decision

Adopt periodization vocabulary [1][2] in code, the database, routes and UI:

| Span | Name | Was |
|---|---|---|
| One full run through a program | **Macrocycle** (`macrocycleNum`, `macrocycle_dashboard`, `macrocycle_scheduled_workout`, web `/macrocycle/<n>`, API `/programs/:program/macrocycles/...` and `/macrocycle-plan`) | cycle |
| The repeating unit of weeks | **Mesocycle** in code (`mesocycleWeeks`, `phaseStyle: 'mesocycle'`); **"Block"** or "Mesocycle" in UI labels | block, wave |
| One training week | **Microcycle** in the glossary; "Week" in the UI | week |

Supporting decisions:

1. **Hard cutover.** Old web routes and API paths are deleted, with no redirects, aliases or
   deprecation window. The app has a single user, so there is no client population to protect.
2. **Physical rename.** One rename-only migration
   (`20261009000000_rename_cycle_to_macrocycle`) renames the columns, tables, indexes, primary
   keys and RLS policy names. Postgres keeps data, grants and row-level-security policies attached
   through `RENAME` [4][5]. A shadow-database `prisma migrate diff` confirms the migrated schema
   equals `schema.prisma`.
3. **Legacy CSV header accepted.** Lift-record import maps the legacy `Cycle #` column onto the
   canonical `Macrocycle #` (`LEGACY_LIFT_RECORD_HEADERS`), because exported files outlive the
   rename.
4. **Explain the overloaded terms; don't hide them.**
   - A developer glossary (`docs/glossary.md`) and an in-app `/glossary` page give each term's
     alternate meanings.
   - Headings link into the in-app page through `GlossaryLink`, typed against the glossary data,
     so a link to an undefined term fails to compile.
   - Program catalog copy keeps each author's own words in quotes and says how the app models
     the program.
5. **Out of scope:** stored values that embed the old word (`sheetName` `"<program>_Cycle_1_…"`),
   frozen code (`legacy/`, `archive/`, root `src/`), historical migrations, and accepted ADRs and
   proposals, which record what was true when they were written.

## Alternatives Considered

- **Keep "Cycle" and document it.** This had the least churn. But the dashboard's "Cycle 1" would
  still read as a 4-week 5/3/1 cycle to most lifters, and the catalog copy already showed the
  confusion inside the app.
- **"Run" / "Program run".** Unambiguous, but it is slang with no standard meaning for the
  sub-unit, so "block" would still need a formal name.
- **Rename in code only, with Prisma `@map` keeping the physical names.** This avoids a migration
  and survives a rolling deploy in which old and new API revisions share the database. With a
  single user, a brief mismatch window during deploy is acceptable. A permanent split between
  code names and database names would cost every future reader of raw SQL or RLS policies.
- **Keep the old routes as aliases or redirects.** Only useful for bookmarks and clients that
  don't exist yet.

## Consequences

- Code, schema, API, routes and UI use one vocabulary, and the glossary maps it to the words
  lifters use.
- The deploy that ships this change has two short broken windows. `deploy.yml` runs migrate → API →
  web, so new code never meets an unmigrated database, but old code meets new:
  - **Migrate → new API revision:** the old API queries the renamed tables, and every DB-backed
    route returns 500.
  - **New API → new web revision:** the old web calls the deleted `/cycles/*` routes, and its
    `/cycle` page redirects to `/onboarding`.

  Accepted for a single-user app. Deploy when the app is not in use.
- **Rollback:** reverting the PR alone is not enough. `prisma migrate status` tolerates an
  applied migration the branch no longer has, so the old code would deploy against the renamed
  schema, and `/readyz` (`SELECT 1`) would not notice. The revert PR must add the reverse renames as
  a forward migration. [`docs/runbooks/macrocycle-rename-rollback.md`](../runbooks/macrocycle-rename-rollback.md)
  has the SQL, verified to restore the pre-rename schema exactly, and the procedure.
- The staging database is shared by every PR's staging run. This change's first staging run
  migrated it, so other branches fail staging until they rebase onto the merged change. The same
  runbook covers restoring staging if the change is abandoned.
- The macrocycle-planning agent's environment variables are renamed `CYCLE_AGENT_*` →
  `MACROCYCLE_AGENT_*`, with no fallback. No deployed service sets either name. Local `.env` files
  need the new names (`apps/api/.env.example`).
- The `AnalyticsEvent` names are renamed (`cycle_started` → `macrocycle_started`, payload key
  `cycle` → `macrocycle`). Nothing emits these events yet, and no dashboard, alert or SLO in
  `infra/` references them or the old routes, so there is nothing downstream to update.
- ADR-016's "Cycle Planning Agent" is now `IMacrocyclePlanningAgent` / `/macrocycle-plan` in code.
  The ADR itself keeps its historical title.

## Amendment: Lift, not Exercise (#1045)

**Date:** 2026-10-22 · **Issue:** [#1045](https://github.com/merickvaughn/lifting-logbook/issues/1045)

This ADR settled the time-structure words. Its other open question
([domain-model D18](../domain-model.md#6-known-divergences)) was the unit being trained: the app
said "lift" almost everywhere and "exercise" in about fifteen user-visible places.

- **Lift** is the one user-facing term. "Lift" already dominated the code, schema and API
  (`Lift`, `custom_lift`, `LiftRecord`, the `lift` column), so the stray "exercise" labels
  converge on it. Renaming the other way would have touched every layer.
- The glossaries (`docs/glossary.md`, `docs/user-guide.md`, in-app `/glossary`) define Lift with
  one wording and list "exercise" as a synonym, because lifters and other apps use it.
- Same exceptions as §4–5 above: program catalog copy keeps its author's words, and a CSV's
  "Exercise" column header is input data that import maps onto Lift. Code comments, CSS class
  names and internal identifiers no user sees are not renamed.

## References

1. Bompa, T. O., & Buzzichelli, C. (2018). *Periodization: Theory and Methodology of Training*
   (6th ed.). Human Kinetics. ISBN 978-1-4925-4480-7.
2. Issurin, V. B. (2010). New horizons for the methodology and physiology of training
   periodization. *Sports Medicine*, 40(3), 189–206.
   [doi:10.2165/11319770-000000000-00000](https://doi.org/10.2165/11319770-000000000-00000)
3. Wendler, J. (2011). *5/3/1: The Simplest and Most Effective Training System for Raw Strength*
   (2nd ed.). Jim Wendler LLC.
4. PostgreSQL 16 documentation — [ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html)
   (`RENAME`, `RENAME COLUMN`, `RENAME CONSTRAINT`) and
   [ALTER POLICY](https://www.postgresql.org/docs/16/sql-alterpolicy.html).
5. Prisma documentation — [Customizing migrations](https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations)
   (renaming a field instead of a drop-and-create).
