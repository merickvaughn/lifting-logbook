# ADR-039: Focus Block Persistence — Server-Stored, Date-Derived, JSON Pools

**Status:** Accepted
**Date:** 2026-10-25
**Issue:** [#1056](https://github.com/merickvaughn/lifting-logbook/issues/1056) (top-level [#1053](https://github.com/merickvaughn/lifting-logbook/issues/1053))
**Related:** [Focus work proposal](../proposals/2026-10-24-focus-work-accessory-blocks.md), [`docs/domain-model.md` §3](../domain-model.md#focus-blocks-sit-beside-the-ladder-not-on-it), [ADR-035](ADR-035-client-side-rest-timer-state.md) (why the timer is client-side), [ADR-037](ADR-037-schedule-dates-program-days.md) (derive, don't store)

---

## Context

A **focus block** is extra accessory work for one muscle area over a calendar month or quarter,
or one period from a custom start date. It runs on dates, separate from the program, and is
layered onto every workout. The core domain (`packages/core/src/focus`, #1055) is pure: it
takes blocks, the workout's planned lifts and the user's calendar day, and returns the day's
focus work. This ADR settles how the blocks, the user's per-workout choices and the daily focus
guide are stored and served.

Five questions needed an answer:

1. **Where** blocks live: the server or the browser.
2. **Whether status is stored.** A block is queued, active or ended.
3. **How the pool and timer are stored.** A pool is up to 20 lifts, each with about a dozen
   prescription fields.
4. **When auto-roll successors are created.** A block set to auto-roll into a next area owes a
   successor once it has started.
5. **Which day it is.** Status and the day's plan depend on the user's calendar day.

## Decision

1. **Server-persisted, mirroring custom lifts.** Two tables, `focus_block` and `focus_day_state`,
   each with a `userId` column and forced row-level security with one isolation policy. The
   daily focus guide is two nullable columns on `user_settings` (`focusBudgetSets`,
   `focusBudgetMinutes`), falling back to `DEFAULT_FOCUS_BUDGET` (9 sets, 20 minutes, the
   prototype's values). A block is durable configuration that follows the user across devices,
   unlike the transient timer state ADR-035 keeps in `localStorage`.

2. **Status is derived from dates on every read and never stored.** `blockStatus(block, today)`
   computes it from `start`, `period` and `align`. A stored status would be a second copy of
   what the dates already say, and would go stale at midnight without a job to update it — the
   redundancy Codd §2 warns about [1], and the reasoning ADR-037 applied to scheduled workouts.
   There is no `cancelledAt` column either: cancelling a queued block deletes it (below), so
   no stored flag competes with the dates.

3. **Pool and timer are JSON columns** (`jsonb`), validated by class-validator DTOs on write
   (`apps/api/src/focus/focus-block.dto.ts`) and re-parsed on read
   (`apps/api/src/adapters/prisma/focus-json.ts`), which drops entries that no longer read as
   pool entries. The day state (`FocusDayState`: per-block mode overrides, picks and trims,
   placement, order, dismissal) is one JSON column on `focus_day_state`, keyed by
   `(userId, program, macrocycleNum, workoutNum)` like the workout override side-tables. The
   enum columns (`area`, `nextArea`, `period`, `align`, `selection`, `overlap`, `progression`,
   `onEnd`) are plain text with CHECK constraints, as `body_weight.unit` is.

4. **Auto-roll successors materialize on read.** `GET /focus/blocks` and a workout's
   `GET .../focus` run core's `expandRollovers` and store any successor now due with
   `createMany({ skipDuplicates: true })` [3], against a unique constraint on
   `(userId, series, start)`. Concurrent reads therefore store a successor once, and a block
   that ended while nobody opened the app still gets its successor on the next read. A
   successor's pool is `defaultFocusPool(area)`: the first catalog accessory lifts with a
   primary muscle in the area. **Declining** a successor is deleting it: `DELETE
   /focus/blocks/:id` also sets the predecessor that would roll into it to `onEnd: 'prompt'`,
   so the next read does not recreate it.

5. **The client sends `today`.** Every endpoint whose answer depends on the day takes a
   required `?today=YYYY-MM-DD` query parameter: the server cannot know the user's time zone,
   and the core date math runs on UTC midnights. A workout's rotation counter is its
   `workoutNum − 1`, which keeps counting across weeks, so a pool larger than a week's workouts
   still cycles through every lift.

## Alternatives Considered

| # | Alternative | Why not |
|---|---|---|
| 1 | Keep blocks in `localStorage`, as the prototype does | Blocks are configuration the user expects on every device, and the ended-block summary reads server-side lift records. ADR-035's reasons for client-side timer state (transient, per-device) do not apply. |
| 2 | A `status` column updated by a scheduled job | A second source of truth that is wrong between midnight and the job's run, plus a job to operate. Derivation is a string comparison. |
| 3 | A `focus_pool_entry` child table instead of a JSON pool | The pool is always read and written whole, with its block, and never queried by field. A child table adds a relation, a cascade and per-entry writes for no query it serves; JSON validated at the boundary keeps the block one row [2]. |
| 4 | Create successors with a scheduled job | The same staleness as alternative 2, and a job to run; the read path already has the blocks in hand, and the unique constraint makes creation on read idempotent. |
| 5 | A `cancelledAt` soft-delete column for Cancel | It would make "cancelled" a stored status beside the date-derived one. Deleting the block and flipping its predecessor to Prompt says the same thing with no new state. |
| 6 | Take the user's time zone and compute `today` on the server | No time zone is stored for the user today, and the client already knows its own calendar day. |

## Consequences

- **Positive:** status can never drift from the dates; the pool and timer round-trip as one row;
  successors appear without any background process; the tables inherit the repo's RLS model
  unchanged (the generic "every `userId` table forces RLS" guard in `rls.db.e2e.spec.ts` covers
  them, and targeted cases prove isolation under the restricted role).
- **Negative:** reads that materialize successors write, so `GET /focus/blocks` is not purely
  read-only; JSON columns get no database-level shape checking beyond `jsonb` validity, so the
  DTOs and read-side guards are the only shape enforcement. Every block endpoint that returns a
  status needs `today` from the client.
- **Neutral:** the ended-block summary needs a user's records for a few lifts across programs,
  so `lift_record` gains an index on `(userId, lift, date)` and `ILiftRecordRepository` gains
  `getRecordsForLifts`.

## References

1. E. F. Codd, ["A Relational Model of Data for Large Shared Data Banks"](https://doi.org/10.1145/362384.362685), *Communications of the ACM* 13(6), 1970 — §2, redundancy and derivable data.
2. PostgreSQL 16 documentation, [§8.14 JSON Types](https://www.postgresql.org/docs/16/datatype-json.html) — `jsonb` storage and when to use JSON over relational columns.
3. Prisma documentation, [`createMany` and `skipDuplicates`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany) — insert that skips rows violating a unique constraint (`ON CONFLICT DO NOTHING`).
4. PostgreSQL 16 documentation, [§5.8 Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) — `ENABLE`/`FORCE ROW LEVEL SECURITY` and policy `USING`/`WITH CHECK`.
