# ADR-046: Supplement Storage — Normalized Current State Beside an Append-Only Change Log

**Status:** Accepted
**Date:** 2026-11-20
**Issue:** [#1374](https://github.com/merickvaughn/lifting-logbook/issues/1374) (part of [#1372](https://github.com/merickvaughn/lifting-logbook/issues/1372), Supplements 2/9)
**Related:** [ADR-039](ADR-039-focus-block-persistence.md) (focus block persistence, the module layout this follows); `packages/core/src/supplements/history.ts` (`stackAsOf`, from #1373)

---

## Context

Supplements keeps a lifter's stack: items, each dosed into slots on named day types, combined
into mixes and split again. The lifter needs two things from storage:

1. **The stack now**, read on every page load and changed by small edits: add an item, move its
   doses, start it, combine two items.
2. **Its history**: what the stack was on a given date, and the full record of an item that was
   removed, so it can be restored.

The core domain from #1373 already defines an append-only `SupplementChange` union and
`stackAsOf`, which replays a log of those changes to the stack at the end of a date.

## Decision

Store **both**, in one transaction per write:

- **Current state in normalized tables**: `supplement_day_type`, `supplement_item`,
  `supplement_dose` and `supplement_mix_part`, with the caffeine cutoff on `user_settings`. An item
  folded into a mix stays in `supplement_item` with `foldedInto` set to the mix's id, so a split
  brings it back; it isn't part of the stack.
- **An append-only change log**, `supplement_change`: one row per `SupplementChange`, keyed by
  `(userId, seq)`, with the change's own fields in a `payload` column. The database enforces
  append-only: `lifting_app`, the role the API connects as, has only `SELECT` and `INSERT` on it
  (migration `20261120000001`).

Every write that changes anything logs it. Item changes have their change types, and the day-type
list and the caffeine cutoff have `day_types_set` and `caffeine_cutoff_set`. A request that changes
nothing, such as a `PATCH` repeating the stored values, saves and logs nothing.

**One function applies a change.** `applyChange` in `packages/core/src/supplements/apply.ts`
turns a change into a new state. A write builds its changes, applies them with `applyChange`,
validates the result with `validateStack`, and saves the new state with the changes, in one
transaction, writing only the tables whose part of the state changed, and the log entries last.
`stackAsOf` replays the log with the same function, so `GET /supplements/as-of/<today>` returns the
stack `GET /supplements` does. If anything fails, neither the rows nor the log entries are stored.

The current-state tables are the source of truth for the stack now. The log is the source of
truth for history: `GET /supplements/as-of/:date` replays it with `stackAsOf`, and restoring a
removed item reads the item from its latest `removed` entry. The repository parses each payload
with defaults for the fields an older entry lacks, so restoring an item removed before a later
version added fields still gives a whole item.

### Serializing writes

A write first takes a per-user transaction lock,
`pg_advisory_xact_lock(hashtextextended(userId, 1374))`, as the macrocycle writes do with their
own key, then loads the state. Writes for one user therefore run one after another, each from the
state the previous one saved, so none saves over another. The lock is held to the end of the
request's transaction. A write waits for it for at most 5 s (`lock_timeout`, as the macrocycle
lock bounds its wait), well inside the request transaction's 15 s, so a write stuck behind a slow
holder is a 409 with the code `supplement-stale`, not a transaction timeout answered as a 500.

The `(userId, seq)` key stays as a backstop for a writer that skips the lock, such as a script.
A write numbers its entries from the `seq` it read, so a collision there, or on any other key,
rolls the transaction back and the API answers 409 with the code `supplement-stale`.

### Dates

Every write takes the lifter's local date as `today`, which is required, and dates its changes
with it. It can't be earlier than the date of the user's last change, or the write is a 400. Dates
never go backwards in `seq` order, so replaying in `(date, seq)` order applies changes in the order
they were made, and a removal can't replay before the restore that followed it.

`today` also can't be more than a day past the server's UTC date. Every time zone, UTC−12 to
UTC+14, is within a day of UTC, so no lifter's real date is refused. Without the bound, one write
dated in the future, from a wrong device clock or a typo, would make every later write a 400 until
that date came, and the app role can't correct the log, which is append-only for it.

A `today` earlier than the last change is rejected, not moved forward to the last change's date.
Rejecting keeps every logged date exactly what the client sent, so the history shows the day the
lifter made the change. The cost is that some honest writes fail: a lifter with two devices in
different time zones, or one who travels west, gets a 400 around midnight until their local date
catches up, and has to retry. Moving the date forward would never fail a write, and replay order
would still hold, but a change could be dated a day later than the lifter's own date. We chose
exactness, because the as-of view is read by date; a client that hits the 400 can retry with the
date the error names.

### Isolation

Every table carries `userId` with `ENABLE` and `FORCE ROW LEVEL SECURITY` and the usual isolation
policy, like the other per-user tables. Items are keyed by `(userId, id)`, and the dose and mix-part
foreign keys name both columns, because foreign-key and unique checks bypass RLS: a key on `id`
alone would let a client-chosen id, from an import say, find or cascade into another user's item.

## Alternatives considered

**Event sourcing, with the log as the only source of truth** (Fowler, *Event Sourcing*). Every read
of the stack would replay the whole log, or read a snapshot kept beside it. The stack is read far
more often than its history, the replay rules in `stackAsOf` record anomalies rather than reject
them, and a bug in replay would change the lifter's current stack rather than only its history.
Rejected: current state stays queryable and constrained by the schema, and the log only has to be
right for history.

**Current state only, with an audit log for display** (Fowler, *Audit Log*). An audit log records
what happened as text for people to read; it can't rebuild a past stack or restore a removed item.
The log here is structured enough to replay, which is what the as-of view and restore need.

**One JSON document per user.** Simple to write, but loses the constraints on slots and status, the
per-row RLS, and the per-table rows Download My Data exports.

## Consequences

- A write rewrites the user's supplement rows. Stacks are tens of items, so this stays cheap, and it
  keeps the save one code path for every kind of change.
- The log only grows. It's a few hundred bytes per change; nothing prunes it.
- The two can disagree if a write path forgets to log. Every write goes through one controller
  method that saves state and changes together, the repository refuses a write that changes the
  state without a change, and the e2e tests assert that `as-of/<today>` equals `GET /` after each
  kind of write.
- Writes for one user wait for each other. A write takes milliseconds, so the wait is short.
- An item folded into a mix keeps its own doses, and removing a day type takes it off those too,
  so splitting the mix later brings them back valid. A part of a mix in the stack is checked with
  it, and a 400 names it as `Mix (Part)`. A part of a removed mix is cleaned but not checked, like
  a removed item, until the mix is restored. Restoring a part of a mix is a 409 naming the
  mix: the part comes back by splitting it, or by restoring a removed mix first.
- Download My Data includes all five tables in `logbook.json`; Clear data keeps them, as setup.
  The staging seed's reset keeps them too, and the caffeine cutoff on `user_settings`, whichever
  role runs it. The app role can't delete the log, and deleting the stack without its log would
  leave a history that replays to a different stack. The owner role, which the documented staging
  command uses, could delete all of it, but a reset that behaved differently by role would be
  harder to reason about, so it keeps them for both.

## Known follow-ups

The API shape later sub-issues need, not built here:

- **Stable dose ids.** Doses and mix parts get new row ids on every save of the stack, and a dose
  has no id in the API, so a change can't name one dose. Wanted by editing and bulk actions,
  [#1377](https://github.com/merickvaughn/lifting-logbook/issues/1377).
- **Batch writes.** Each request is one write; a client making many edits sends many requests,
  each taking the lock. [#1377](https://github.com/merickvaughn/lifting-logbook/issues/1377) and
  [#1379](https://github.com/merickvaughn/lifting-logbook/issues/1379).
- **An `imported` change type**, so an import is one entry the history can show and undo rather
  than one `added` per row. [#1379](https://github.com/merickvaughn/lifting-logbook/issues/1379).

## References

- [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html): the
  rejected alternative of making the log the source of truth.
- [Martin Fowler — Audit Log](https://martinfowler.com/eaaDev/AuditLog.html): the simpler log that
  can't rebuild past state.
- [PostgreSQL 16 — Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html):
  forced RLS and an isolation policy on every supplement table.
- [PostgreSQL 16 — Unique constraints and primary keys](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-PRIMARY-KEYS):
  the `(userId, seq)` key, the backstop against a writer that skips the lock.
- [PostgreSQL 16 — Advisory lock functions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS):
  `pg_advisory_xact_lock`, the per-user write lock held to the end of the transaction.
- [PostgreSQL 16 — GRANT](https://www.postgresql.org/docs/16/sql-grant.html) and
  [REVOKE](https://www.postgresql.org/docs/16/sql-revoke.html): `lifting_app` may only read and
  insert change-log rows.
- [Prisma — Interactive transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions#interactive-transactions):
  the transaction a save runs in when no request transaction encloses it.
