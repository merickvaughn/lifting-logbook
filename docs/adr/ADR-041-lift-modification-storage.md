# ADR-041: Lift Modifications Are Rows Keyed to a Lift, and Each Set Records Their Ids

**Status:** Accepted
**Date:** 2026-11-05
**Issue:** [#1151](https://github.com/merickvaughn/lifting-logbook/issues/1151) (top-level [#1140](https://github.com/merickvaughn/lifting-logbook/issues/1140))
**Related:** [Lift Modifications proposal](../proposals/2026-11-05-lift-modifications.md), [`docs/domain-model.md` §2](../domain-model.md#modifications-change-how-a-lift-is-performed), [ADR-039](ADR-039-focus-block-persistence.md) (the pattern for a new user-scoped table)

---

## Context

A lifter often changes how they perform a lift without it becoming a different lift: a wider grip
on cable curls, or a mixed grip for the last reps of a deadlift. The app could only record that as a
free-text note, or as a new lift with its own split-off history. The owner approved the design in
the proposal on 2026-11-05: a **modification** is a user-defined change linked to one lift, toggled
during a workout, and recorded on each set.

This ADR settles how the first phase stores it. The logger, own maxes, import and program slots come
in later phases ([#1152](https://github.com/merickvaughn/lifting-logbook/issues/1152) to
[#1155](https://github.com/merickvaughn/lifting-logbook/issues/1155)).

Five questions needed an answer:

1. How a modification points at its lift, when catalog lifts aren't rows and `lift_record.lift` holds
   mixed spellings.
2. How a set records its modifications.
3. Where the rules a column can't express are enforced.
4. What delete does once a set names the modification.
5. How a set's response names a modification.

## Decision

1. **`lift_modification` is a user-scoped table keyed to the lift's id.** `lift` holds a catalog id
   or a custom lift's uuid, written through `lookupLift` as `custom?.id ?? builtIn?.id`, with no
   foreign key because catalog lifts aren't rows. It is a plain string until
   [#1142](https://github.com/merickvaughn/lifting-logbook/issues/1142) adds `LiftId`. A name that
   resolves to no lift is a 400 on create. The unique constraint on `(userId, lift, name)` also
   serves reads by user and lift, so the table has no separate index. The table has forced row-level
   security with one isolation policy, in the migration that creates it, as every table does [1].
   `maxMode` is text with a CHECK constraint, as `focus_block`'s enum columns are.

2. **`lift_record.modifications` is a `text[]` of ids, not a join table.** It defaults to empty, and
   adding it doesn't rewrite the table [2]. It is not part of the natural key or the public id: a
   modified set is still set N of that lift, so existing ids and
   [D4](../domain-model.md#defects) are unaffected. In the code the field is left absent when empty,
   as `occurrence` is at 0, so an unmodified record and its response keep their earlier shape.

3. **The write rules live above the port, in `assertSetModifications`.** Each id must belong to this
   user and to the set's lift, with at most one `own`, or the request is a 400. The check needs both
   a read of the user's modifications and the lift resolver, so it sits with the controller and both
   adapters get it. Another user's id reads the same as an unknown one, so the 400 reveals nothing.
   A set is checked through the same lookup as a create, so a modification made on `Bench Press`
   attaches to a set logged as `bench-press`. A custom lift can share a catalog lift's name, and then
   `Cable Curl` means the custom lift while `cable-curl` means the built-in. To the lifter they are one
   lift, so the check and the list filter accept either id. An edit also skips the lift check for ids
   the set already has, because a custom lift renamed since leaves the set under a name that no longer
   resolves.

4. **Delete removes a modification no set names, and otherwise archives it.** Archived rows leave the
   list and take no edits, but sets still name them. The check is a query on the array inside the
   user's rows. An archived id is still accepted on a set, so a set that names one can be edited, and
   a page open across the archive can still log. A modification no set names is gone, so a page still
   showing it gets a 400 on the set, and the logger must refresh its toggles and keep the set's draft
   ([#1152](https://github.com/merickvaughn/lifting-logbook/issues/1152)). Creating an archived
   modification's name again brings
   the same row back: the unique constraint covers archived rows, and refusing would answer 409 to a
   name the user can't see. Renaming onto an archived name is still a 409.

5. **A set's response carries `{ id, name }`, not bare ids.** `LiftRecordResponse` and `SetResponse`
   name each modification, so a rename shows everywhere and an archived one is still named, with no
   second endpoint for archived rows. The names come from one read of the user's modifications, made
   only when a record in the response has any, so a workout with none costs no extra query.

## Consequences

- `saveWorkout` and `appendLiftRecords` name their fields, so both carry `modifications`. A writer
  that adds a field list later must too, or it clears them silently.
- `alternativeNames` is on the table from the start, because the design stores it there and import
  ([#1154](https://github.com/merickvaughn/lifting-logbook/issues/1154)) adds no migration of its own.
  Nothing reads or writes it yet, and the API doesn't expose it.
- An id in `lift_record.modifications` has no referential integrity. The delete rule keeps it
  resolvable except when a delete races a log, since neither sees the other's uncommitted write. A
  read that finds no row leaves the id out of the response and logs a warning, rather than fail. The
  window needs one user in two tabs, so it isn't worth row locks in raw SQL, which would also need
  manual spans.
- Until [#1142](https://github.com/merickvaughn/lifting-logbook/issues/1142), a custom lift sharing a
  catalog name can hold the same modification name twice, once under each id, and a set logged under a
  custom lift's old name can't take a new modification.
- Modifications stay out of what reaches the LLM provider: `get_lift_history` strips the ids, which
  mean nothing to it, and nothing has decided whether names and descriptions should go.
- Duplicate names are compared exactly, as custom lift names are, so `Wide grip` and `wide grip` can
  both exist on a lift.
- Deleting a custom lift leaves its modifications behind, with nothing to reach them by. They belong
  to the user, and no phase needs them cleaned up yet.
- A `PATCH` that changes `maxMode` to `own` can leave old sets with two `own` modifications. The rule
  applies to the list a write sends, so editing such a set needs one of them removed.

## Alternatives Considered

| # | Alternative | Why not |
|---|---|---|
| 1 | A join table `lift_record_modification` instead of `text[]` | Referential integrity, but every set read gains a join, and each bulk write gains a step: `createManyAndReturn` [3], which only returns the rows it created, then a second insert keyed on them. The schema already uses `String[]` this way, and the archive rule covers the dangling-id case |
| 2 | Record per lift per workout, in an override side table | Owner decision 5: it can't show mixed grip on set 1 only |
| 3 | Bare ids in the set response, with `?includeArchived=true` on the list | The client would join two responses to show a name, and a failed list fetch would lose names on sets already logged |
| 4 | Enforce the write rules inside each adapter | Two copies of a rule that needs the lift resolver and the user's custom lifts, and an adapter has no HTTP error to raise |
| 5 | A partial unique index that ignores archived rows | Two rows of one name on one lift, so old sets and new ones would show one name under two ids. Prisma's schema can't express it either |

## References

1. PostgreSQL 16 documentation, [§5.8 Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) — `ENABLE`/`FORCE ROW LEVEL SECURITY` and policy `USING`/`WITH CHECK`.
2. PostgreSQL 16 documentation, [`ALTER TABLE`, Notes](https://www.postgresql.org/docs/16/sql-altertable.html#SQL-ALTERTABLE-NOTES) — adding a column with a constant default doesn't rewrite the table; and [§8.15 Arrays](https://www.postgresql.org/docs/16/arrays.html).
3. Prisma documentation, [`createManyAndReturn`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmanyandreturn) — the bulk write a join table would need.
