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
  `(userId, seq)`, with the change's own fields in a `payload` column. The app inserts rows and
  never updates or deletes them.

Every write reads the current state, applies the change, validates the result with
`validateStack`, and saves the new state and its log entries in the request's transaction, the log
entries last. If anything fails, neither the rows nor the log entries are stored.

The current-state tables are the source of truth for the stack now. The log is the source of
truth for history: `GET /supplements/as-of/:date` replays it with `stackAsOf`, and restoring a
removed item reads the item from its `removed` entry.

The `seq` primary key also serializes writes. A write numbers its entries from the `seq` it read,
so when another write appends first, the insert hits the key, the transaction rolls back, and the
API answers 409.

Every table carries `userId` with `ENABLE` and `FORCE ROW LEVEL SECURITY` and the usual isolation
policy, like the other per-user tables.

### Writes that don't log

`SupplementChange` records changes to items. Changing the day types logs a `moved` entry for each
item whose doses lose a day type, but the day-type list and the caffeine cutoff themselves have no
change type, so a write that changes only those appends nothing. Adding change types for them is
left to the history UI that would read them.

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
  method that saves state and changes together, and the e2e tests assert the log after each write.
- Download My Data includes all five tables in `logbook.json`; Clear data keeps them, as setup.

## References

- [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html): the
  rejected alternative of making the log the source of truth.
- [Martin Fowler — Audit Log](https://martinfowler.com/eaaDev/AuditLog.html): the simpler log that
  can't rebuild past state.
- [PostgreSQL 16 — Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html):
  forced RLS and an isolation policy on every supplement table.
- [PostgreSQL 16 — Unique constraints and primary keys](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-PRIMARY-KEYS):
  the `(userId, seq)` key that stops two writes appending the same change.
- [Prisma — Interactive transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions#interactive-transactions):
  the transaction a save runs in when no request transaction encloses it.
