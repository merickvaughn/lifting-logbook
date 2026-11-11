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
   /focus/blocks/:id` also sets to `onEnd: 'prompt'` every predecessor the deleted block was
   keeping from rolling, so the next read does not create a successor in its place. "Keeping
   from rolling" is decided by `expandRollovers` itself (owed without the block, not with it),
   so a user-queued block that starts mid-period is handled the same as an auto-created one.
   **Priority** orders only blocks that have not ended: a reorder lists exactly those, and a
   new block goes below them. Ended blocks keep their last priority, which nothing reads, so
   their unbounded accumulation never limits a reorder.

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

## Amendment 1 — `today` from `apps/web` Server Components (#1072)

Decision 5 assumed the caller knows the user's day. In `apps/web`, most callers are Server
Components, and their clock is UTC: for a user west of UTC that is tomorrow every evening.
The browser now records its IANA time zone in a `tz` cookie (`components/TimeZoneCookie.tsx`),
and `getUserToday()` (`lib/userToday.ts`) reads it to give the user's ISO day, falling back to
UTC when the cookie is missing or holds a zone `Intl` doesn't recognise [5][6]. The API contract
doesn't change: it still takes `?today=` and still stores no time zone, so alternative 6 stays
rejected. Client Components keep computing the day from the browser clock (`localToday`).

## Amendment 2 — progression types and the successor pool (#1213)

The `progression` column now holds the shared lift vocabulary
([proposal](../proposals/2026-11-10-lift-progression-types.md), "Focus blocks"): `double`,
`manual` (was `fixed`), `percent_wave` (was `tm`) and `rpe`. Migration
`20261111120000_focus_progression_types` renames the stored values and swaps the CHECK. It is
the first migration to update `focus_block` rows, and the table has `FORCE ROW LEVEL SECURITY`
[4], which binds the table owner. For a role that doesn't bypass RLS, an UPDATE with no
`app.current_user_id` matches nothing. `docs/deploy.md` says the migrator bypasses it, but the
migration doesn't depend on that: it turns FORCE off around its one UPDATE, so the owner sees
every row either way, and back on after it [7]. PostgreSQL runs a multi-statement
query string as one transaction [8], and Prisma Migrate sends a migration file that way, as the
"cannot run inside a transaction block" error from `CREATE INDEX CONCURRENTLY` in a migration
shows. So a failure leaves FORCE on. Until the migration has run, a read maps an old value to its
new name; that mapping is read-side only, and
[#1220](https://github.com/merickvaughn/lifting-logbook/issues/1220) removes it. The DB e2e suite
runs the file as one query, as a table owner that is neither superuser nor `BYPASSRLS`, so it fails
if the FORCE handling is removed.

**Deploy window and rollback.** Migrations run before the new API revision serves (ADR-027), so
for a short window the old API reads rows the migration renamed. The old `prescribe` has no case
for `manual` or `percent_wave` and throws, so the focus plan for such a block returns 500 until the
new revision takes traffic. The web treats that like any failed focus plan (`loadFocusPlan`): the
workout shows its planned lifts and the details page says the focus plan didn't load. The same
fallback covers the next window, the new API with the old web, whose shape check doesn't know the
new values. Block reads are unaffected, because the old repository casts the stored value without
checking it, and only writes are validated. Rolling back the API alone after the migration has run hits the same
500, so a rollback reverses the data first:

```sql
ALTER TABLE "focus_block" DROP CONSTRAINT "focus_block_progression_check";
ALTER TABLE "focus_block" NO FORCE ROW LEVEL SECURITY;
UPDATE "focus_block" SET "progression" = CASE "progression" WHEN 'manual' THEN 'fixed' WHEN 'percent_wave' THEN 'tm' END
WHERE "progression" IN ('manual', 'percent_wave');
ALTER TABLE "focus_block" FORCE ROW LEVEL SECURITY;
ALTER TABLE "focus_block" ADD CONSTRAINT "focus_block_progression_check"
  CHECK ("progression" IN ('double', 'fixed', 'tm', 'rpe'));
```

Decision 4 changes for `percent_wave`. A block is one wave, so its training maxes carry into
the successor: a successor lift that the block also had keeps the block's entry, with its max
raised by the user's `defaultWeightIncrement`. Other successor lifts still come from
`defaultFocusPool(area)`, and the other progression types are unchanged. The successor is stored
on the first read after its block starts, so a max edited later in the block would otherwise never
reach it: while the successor is still queued, an edit to a block's training max moves the
successor's max for the same lift by the same amount, which keeps any edit already made to the
successor. Other settings edits still don't follow
([#1222](https://github.com/merickvaughn/lifting-logbook/issues/1222)).

A `double` entry progresses in the prescription instead: once every rep in its `lastReps` reached
`repsHigh`, it plans its weight plus the increment. Nothing extra is stored for that, so whatever
writes `lastReps` must also write the weight those reps were done at
([#1221](https://github.com/merickvaughn/lifting-logbook/issues/1221)).

The two use different increments on purpose. A `double` bump is planned inside a workout, so it
uses the increment that workout's weights round to: the program day's increment, or the user's
default when the day has none, the same increment a `percent_wave` weight in that workout rounds to.
A successor is created when focus blocks are read, outside any workout and any program, so it
uses the user's default.

## Amendment 3 — recording a `double` entry's last session (#1221)

Amendment 2 left `lastReps` with no writer. A workout's focus plan read now writes it
(`recordFocusSessions` in `focus.util.ts`, over core's `recordLastSessions`), the same way the
blocks read creates a successor. For each `double` block active on `today`, each pool lift's last
session is its sets on the latest day inside the block's range and before `today`. The entry takes
that day's reps in set order as `lastReps`, the lightest of those sets' weights as `weight`, and
the day as a new `lastDate`. The block is stored only when an entry changed.

- **Before `today`, not including it.** The details page, the logger and the timer all re-read the
  plan during a session. If today's sets counted, logging the last set at the top of the range
  would raise the weight of the sets still to do. Two workouts on one day see the same last
  session.
- **Once per session.** A session later than the entry's `lastDate` is recorded once. A weight the
  user edits in setup afterwards stands until the next session, rather than being reset from the
  same records on the next read. A correction to that session's sets after it was recorded isn't
  picked up. The setup page sends an entry back whole, so a block update that changes an entry's
  weight but returns its `lastReps` unchanged drops them (`withoutStaleLastReps`): they were done
  at the old weight, and would otherwise bump the new one.
- **The lightest set's weight.** `prescribe` adds the increment to `weight` once every rep in
  `lastReps` reached `repsHigh`, so `weight` has to be a load every one of those sets was done at
  or above.
- **Inside the block's range.** A new block starts from its configured weight, not from the same
  lift's sets in an earlier block.

The recorded values are capped at the bounds the block DTOs accept (`FOCUS_LIMITS`), which are
tighter than a lift record's, so the setup page can still send the pool back. `GET /focus/blocks`
doesn't record sessions: the setup page shows an entry's weight as of the last plan read.

**Rejected: write on each lift-record write.** A lift record doesn't say which block it was logged
for, and a pool lift can also be a planned lift or sit in two blocks. Writing per set would also
move the session's own plan mid-session, which a "before `today`" read avoids without a second
field for the session in progress.

## References

1. E. F. Codd, ["A Relational Model of Data for Large Shared Data Banks"](https://doi.org/10.1145/362384.362685), *Communications of the ACM* 13(6), 1970 — §2, redundancy and derivable data.
2. PostgreSQL 16 documentation, [§8.14 JSON Types](https://www.postgresql.org/docs/16/datatype-json.html) — `jsonb` storage and when to use JSON over relational columns.
3. Prisma documentation, [`createMany` and `skipDuplicates`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany) — insert that skips rows violating a unique constraint (`ON CONFLICT DO NOTHING`).
4. PostgreSQL 16 documentation, [§5.8 Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) — `ENABLE`/`FORCE ROW LEVEL SECURITY` and policy `USING`/`WITH CHECK`.
5. ECMA-402, [`Intl.DateTimeFormat` — `timeZone` option](https://tc39.es/ecma402/#sec-createdatetimeformat) — IANA zone names, and the `RangeError` for an unknown one.
6. IETF [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265), *HTTP State Management Mechanism* — the `Path` and `Max-Age` cookie attributes the `tz` cookie sets.
7. PostgreSQL 16 documentation, [`ALTER TABLE`](https://www.postgresql.org/docs/16/sql-altertable.html) — `NO FORCE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY`.
8. PostgreSQL 16 documentation, [§55.2.2.1 Multiple Statements in a Simple Query](https://www.postgresql.org/docs/16/protocol-flow.html#PROTOCOL-FLOW-MULTI-STATEMENT) — a multi-statement query string runs as one implicit transaction.
