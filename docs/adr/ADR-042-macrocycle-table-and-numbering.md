# ADR-042: Every Macrocycle Gets a Row, and a New One Takes the Next Free Number

**Status:** Accepted
**Date:** 2026-11-10
**Issue:** [#1197](https://github.com/merickvaughn/lifting-logbook/issues/1197) (piece 1 of [#1171](https://github.com/merickvaughn/lifting-logbook/issues/1171), top-level [#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170))
**Related:** [Import macrocycle assignment proposal](../proposals/2026-11-06-import-macrocycle-assignment.md) (decisions 1, 2, 3, 13 and 18), [`docs/domain-model.md`](../domain-model.md) D9 and D14, [ADR-039](ADR-039-focus-block-persistence.md) (the pattern for a new user-scoped table)

---

## Context

Before this change, the database stored only the current macrocycle. `macrocycle_dashboard` is unique on user and program, and `macrocycleNum` lives as a bare integer on seven tables: `lift_record`, `macrocycle_dashboard`, the three workout override tables, `focus_day_state` and `macrocycle_scheduled_workout`. A finished macrocycle had no start date, end date or status, and nothing listed past macrocycles ([D9, D14](../domain-model.md#defects)).

Importing history ([#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170)) has to put older macrocycles somewhere. Those macrocycles must not change training maxes, and their numbers must never collide with a live macrocycle. The owner accepted the proposal's design. They split #1171 into four PRs:

1. This one: the table, the guards, the list and the backfill function.
2. The stable id ([#1198](https://github.com/merickvaughn/lifting-logbook/issues/1198)).
3. The renumbering engine ([#1199](https://github.com/merickvaughn/lifting-logbook/issues/1199)).
4. The renumbering backfill, in a later deploy ([#1200](https://github.com/merickvaughn/lifting-logbook/issues/1200)).

The owner's reason for the split: migrations run while the previous API revision still serves. Stored numbers can only change once every client sends the stable id, so the renumbering deploy has to come after the one that adds the table.

## Decision

1. **A `macrocycle` table holds one row per user, program and number.**
   - Each row has a start date, a nullable end date, a status (`completed`, `abandoned`, `overran`, `in-progress`, `unknown`) and whether the lifter chose that status.
   - It also has an origin (`imported`, `live`, `legacy`, `non-cycle`), an `unmatched` flag, and an `importedThrough` date for a continued imported run.
   - CHECK constraints hold status and origin to the lists in `packages/types`.
   - The table has forced row-level security with one isolation policy, in the migration that creates it, as every user-scoped table does [1].
   - `macrocycle_dashboard` stays the pointer to the current macrocycle.

2. **A new macrocycle takes the next free number.** The number is the larger of the highest stored number and the dashboard's, plus one.
   - It applies to every path that creates a macrocycle: initialize, starting the next one, and `fromMacrocycleNum`, which used to reuse the source number + 1.
   - So a new live macrocycle can never land on an imported or legacy number.
   - The unique key is the backstop. When two writers race for one number, the second write fails, and Prisma's `P2002` [2] becomes a 409 with code `macrocycle-number-taken`. The request's transaction rolls back, so nothing is written.
   - Numbers follow start date only after [#1199](https://github.com/merickvaughn/lifting-logbook/issues/1199) adds the renumbering engine. Until then a number is allocated and never rewritten.

3. **Live macrocycles keep their rows current.**
   - Creating a macrocycle creates its row as `live` and `in-progress`.
   - Starting the next one closes the previous row. Its end date is its last set's date. It's `completed` when every workout of the program has a logged set, and `abandoned` otherwise, because starting the next one is a restart. A workout number past the program's length doesn't count.
   - A program with no known length closes as `unknown`.
   - A status the lifter chose is never overwritten.
   - On read, an `in-progress` row whose last session is more than 14 days old reads as `abandoned`, so it can't go stale. This excludes the current macrocycle and a status the lifter chose.
   - On read, a row's dates widen to cover its sets. Sets logged into a closed macrocycle, or uploaded into a legacy one, don't move the stored dates.

4. **Writes check the macrocycle's row first.**
   - An `imported` number returns 409 with code `macrocycle-read-only`.
   - A number the program doesn't have returns 404 with code `macrocycle-not-found`.
   - `live` and `legacy` numbers stay writable.
   - The guard covers every route in proposal decision 2:
     - `fromMacrocycleNum`.
     - Lift-record `POST`, `PATCH` and import.
     - Lift-override `POST` and `DELETE`.
     - Reschedule.
     - Skip `POST` and `DELETE`.
   - The current macrocycle gets its row on first write if it has none, for macrocycles the previous API revision started. That insert uses `ON CONFLICT DO NOTHING` [3], so two requests creating the row at once both succeed.
   - A file number with no row gets a `legacy` row dated by the file's sets. A file number must be from 1 to 1000, the bound `POST lift-records` applies, so a typo can't push every later number past it. Undoing the import removes a `legacy` row it created once the row has no sets left.
   - With no dashboard, workout and focus routes address the highest number + 1, so an imported number 1 is never read or written as live.
   - Deleting the current macrocycle keeps `imported` rows and their sets.

5. **A backfill function gives every stored number a row.** `macrocycle_backfill_rows()` inserts one row per distinct user, program and number across the seven tables.
   - The dashboard's number is `live`, `in-progress`, and starts on `macrocycleDate`, so it works with zero sets.
   - Every other number is `legacy` with status `unknown`, shown as "Status unknown", because `lift_record` has no origin to tell imported sets from logged ones.
   - A start date comes from the first of these that exists:
     1. The number's first set.
     2. Its first scheduled date.
     3. The start of the nearest lower number.
     4. The program's earliest start.
     5. Today.
   - It inserts with `ON CONFLICT DO NOTHING` [3], so running it again changes nothing.
   - The migration calls it once.
   - #1200 calls it again for numbers the old revision created during the deploy window.
   - `EXECUTE` is revoked from `PUBLIC`, so the app role can't run it.

6. **`GET /programs/:program/macrocycles` lists a program's macrocycles in start-date order.** Each has its id, which stays the same when a number changes, plus its dates, its status as read today, its origin and whether it's current. History shows them on a Macrocycles tab.

## Alternatives rejected

- **Deriving past macrocycles from `lift_record` dates alone.** A status, a chosen status, an empty macrocycle and an unmatched stretch can't be stored or edited that way (proposal decision 1).
- **Widening `macrocycle_dashboard` to hold every macrocycle.** Its uniqueness is one row per user and program, and every reader treats it as the current pointer.
- **Keeping source + 1 for `fromMacrocycleNum`.** That lands on a stored number whenever an imported or legacy macrocycle sits above the source, and the unique key would then fail every such start.
- **Renumbering by start date in this PR.** The previous API revision, still serving while migrations run, doesn't send a stable id, so a rewritten number would point its writes at the wrong macrocycle. The owner chose to split this into its own deploy.
- **A backfill written as one-off migration SQL.** A function can be run again by #1200 and called from the DB e2e suite against seeded rows.

## Consequences

- Two error codes change. `fromMacrocycleNum` for a number the program lacks used to return 400 and now returns 404 `macrocycle-not-found`. Logging a set to a number with no row returns 404, where it used to create the set. The web logger posts to its URL's number, which always has a row.
- Imported history can't be edited set by set. Correcting it means undoing its import ([#1181](https://github.com/merickvaughn/lifting-logbook/issues/1181)).
- `agent-tools.ts` leaves out set notes it can't vouch for. Those are notes on `imported` or `legacy` macrocycles, or dated up to a row's `importedThrough`.
- Download My Data includes the table.
- **Rollback:** reverting the API image is safe, because the old code ignores the table. Dropping the table loses only the rows, which the function can rebuild for any number still stored.

## References

1. [PostgreSQL 16 — Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)
2. [Prisma — Error message reference, `P2002`](https://www.prisma.io/docs/orm/reference/error-reference#p2002)
3. [PostgreSQL 16 — `INSERT`, `ON CONFLICT` clause](https://www.postgresql.org/docs/16/sql-insert.html#SQL-ON-CONFLICT)
4. [PostgreSQL 16 — PL/pgSQL, obtaining the result status (`GET DIAGNOSTICS`)](https://www.postgresql.org/docs/16/plpgsql-statements.html#PLPGSQL-STATEMENTS-DIAGNOSTICS)
5. [PostgreSQL 16 — Explicit locking, row-level locks](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS): a second insert of a key held by an uncommitted transaction waits for that transaction, then fails, which the concurrency test relies on.
