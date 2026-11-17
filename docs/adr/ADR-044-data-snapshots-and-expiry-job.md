# ADR-044: Clear Data Saves a Compressed Snapshot, and Its Expiry Job Reaches Expired Rows Through an Owner-Only Policy

**Status:** Accepted
**Date:** 2026-11-15
**Issue:** [#1309](https://github.com/merickvaughn/lifting-logbook/issues/1309) (part of [#1181](https://github.com/merickvaughn/lifting-logbook/issues/1181), top-level [#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170))
**Related:** [Import macrocycle assignment proposal](../proposals/2026-11-06-import-macrocycle-assignment.md), decisions 20 to 22; [ADR-027](ADR-027-deploy-pipeline-migrations.md) (the migrate job this job mirrors); [ADR-042](ADR-042-macrocycle-table-and-numbering.md) (renumbering by start date)

---

## Context

Clear data removes a lifter's training data and keeps their setup (decision 20). Decision 21 says
it first saves a server snapshot that the lifter can restore, delete or download for 30 days, and a
daily job deletes expired snapshots.

Three things needed deciding: how a snapshot stores the rows, how a restore puts them back without
overwriting anything stored since, and how the expiry job reads rows that row-level security hides.

Decision 21 assumed the job could run "under the migration role that row-level security doesn't
filter". Migration `20261112000003` showed that isn't true here. The migrator owns the tables but
isn't a superuser or `BYPASSRLS`, every table has `FORCE ROW LEVEL SECURITY`, and forced security
binds the owner too. With no `app.current_user_id` set, the isolation policy hides every row from
it. A job that deleted "expired rows" as the migrator would see none, delete none and report
success.

## Decision

1. **One `data_snapshot` row per clear.** It holds the user, the kind (`clear`), the scope (the
   programs with rows), the row counts per table, the expiry, and the rows as gzip-compressed JSON
   in a `BYTEA` column. Dates are written as `{"$date": ISO}` so they come back as dates, and the
   payload carries a version. The table has the usual forced isolation policy. A snapshot is
   written back with the columns it was read with, so a migration that changes a cleared table's
   columns must give a new column a default, or raise the payload version and read the old one.
   `snapshots.db.e2e.spec.ts` pins each cleared model's columns, so such a migration fails a test
   until that's decided.
2. **The snapshot covers exactly what Clear removes.** That's decision 20's eleven tables plus
   `lift_modification_max`, the own maxes of lift modifications, which the owner chose to clear.
   `missing_max_dismissal` stays, also the owner's choice. The snapshot is saved, then the tables
   are cleared, in one transaction that holds the import and macrocycle locks. If the save fails,
   the transaction rolls back and nothing is cleared. If the stored counts differ from the ones the
   lifter confirmed, nothing happens and the response is a 409.
3. **Restore inserts only what's missing, then renumbers.**
   - **Sets stored again are left out.** A snapshot set whose date, lift and set number a stored
     set already holds, in any program, isn't restored: decision 13's duplicate rule, the
     owner's choice, so a lifter who imported the clear's download before restoring doesn't get
     every set twice. A macrocycle left with no sets isn't restored, nor its other rows, unless
     it's the current one and its dashboard comes back. A non-cycle workout left with no sets
     loses its rows. Batch keys naming what was left out are dropped, and a batch left with
     nothing to undo isn't restored.
   - **Numbers move past the stored ones.** For each program, the snapshot's macrocycle numbers
     move past every number stored now, in every numbered table, and its import batches' keys
     move with them. A batch imported since the clear names only numbers in use, because
     deleting a macrocycle drops its keys (#1199). Non-cycle workouts share one macrocycle that is
     never renumbered, so their workout numbers move past the logged ones instead, and so do the
     `non-cycle:` keys any program's batch holds for them (#1184). The non-cycle macrocycle then
     starts at its earliest set.
   - **Then each row goes in unless a stored row holds its key:** `createMany` with
     `skipDuplicates` in Postgres. So a program's dashboard, a lift's training max and a
     modification's own max saved since the clear are kept. When the dashboard is kept, the
     snapshot's current macrocycle comes back closed, as starting the next macrocycle closes one.
     Each program is then renumbered by start date (ADR-042), and the snapshot is deleted. A
     restore can't run twice.
   - **Clear locks the rows it saves.** It runs at `READ COMMITTED` and waits for the import and
     macrocycle locks, so it sees every set a page write holding the lock committed while it
     waited. It then locks each cleared table's rows with `SELECT ... FOR UPDATE`, so a write that
     takes neither lock, such as a training-max edit, can't change one between the snapshot and
     the delete. A row added between the lock and the read would be saved unlocked, so when the
     rows read differ from the rows locked, it rolls back with a 409 before saving. When the
     delete removes more rows than the snapshot holds, a row was added after the read, and the
     transaction rolls back with a 409 too. A write that still collides with clear or
     restore (a modification deleted under restore, a deadlock) also rolls it back with a 409
     rather than being deleted unsaved or breaking a foreign key. Their transaction may take 60
     seconds: on 2026-11-15 a local Postgres 16 cleared
     78,000 sets, a heavy lifter's ten years, in 2.4 s, row locks included, and restored them in
     15.7 s.
4. **Every read treats an expired snapshot as gone.** List, restore and download filter on
   `expiresAt > now`, so a late or failed job never extends retention.
5. **The expiry job reaches expired rows through two owner-only policies.** `data_snapshot` has a
   `SELECT` policy and a `DELETE` policy, each `USING ("expiresAt" <= (now() AT TIME ZONE 'UTC')
   AND current_user = <the table's owner>)`. `expiresAt` is a `timestamp` holding UTC wall-clock
   time, as Prisma writes it, so the comparison is in UTC whatever the session's `TimeZone`. The
   owner is read from `pg_class`, so the policies hold whichever role ran the migration. Policies
   of one command combine with `OR`, so the API role still sees only the current user's rows. The
   job is a script in the API image, run as a Cloud Run job with the migrator connection, retried
   once since deleting is idempotent. It checks that it runs as the table's owner, deletes rows up
   to one UTC cutoff, counts what's left up to the same cutoff, logs both as JSON, and exits
   non-zero when it isn't the owner or a row is left. A daily workflow executes it, as
   `deploy.yml` executes the migrate job, and opens or comments on a `snapshot-expiry-failed`
   issue when a run fails.

## Alternatives considered

- **Turn `FORCE ROW LEVEL SECURITY` off for the job's transaction**, as `20261112000003` does for
  its backfill. Rejected: `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock, so a daily job would
  block every snapshot read and write while it ran, and a crash between the two `ALTER`s would
  leave the table unforced. The policies need no lock and can't be left half-applied.
- **Leave `data_snapshot` unforced**, so its owner bypasses the policies. Rejected: it would be the
  one user table where the owner sees everything, against the convention every other table
  follows, for a job that needs only expired rows.
- **Set `app.current_user_id` to each user in turn.** Rejected: the job would first need the list
  of users with snapshots, which it can't read either, and a per-user loop is slower and more code
  for the same result.
- **Store snapshots as rows in shadow copies of each table.** Rejected: twelve more tables, each
  migrated with its source table. A versioned payload asks a schema change for a default or a
  reader of the old version instead, and the column pin says when.
- **Restore by overwriting.** Rejected by decision 21's own wording: restore must not lose anything
  saved since the clear.
- **Run clear and restore at `REPEATABLE READ`.** Rejected: that level fixes what a transaction
  sees at its first statement, which is setting the row-level-security user, before the wait for
  the macrocycle lock. A set a page write added and committed during the wait would be invisible
  to clear: neither saved nor deleted, and left on a macrocycle clear had removed. Postgres can't
  take an advisory lock before that first view.
- **Restore every snapshot set, beside any stored again since.** Rejected by the owner: after
  importing the clear's download and then restoring, every set would be stored twice under
  different macrocycles.

## Consequences

- A restore can bring back a training max for a lift that has none now, beside newer maxes for
  other lifts. That's the "missing only" rule, not a merge of values.
- A restored import batch keeps working for undo, because its pre-image keys move with the
  macrocycle numbers and its non-cycle keys with the non-cycle workout numbers.
- Restored non-cycle workouts are numbered after those logged since the clear, not put back in
  date order with them.
- In the `SYSTEM_DATABASE_URL`-only mode, which no deployment uses, the user context runs with no
  transaction, so clear and restore aren't atomic there, as no write path in that mode is.
- The expiry policies give the migrator read and delete access to expired snapshots of every user.
  The migrator already owns the table and could drop it, so this grants nothing it couldn't take.
- Overwrite with a fresh import (the proposal's overwrite criteria) can reuse the table and payload
  with another `kind` and a narrower scope. The addendum below records how it did.

## Addendum (2026-11-16): import overwrite backups

[#1182](https://github.com/merickvaughn/lifting-logbook/issues/1182) built decision 19, replacing
stored history with an import, on this table, as the consequence above expected.

1. **A second kind, `overwrite`.** Before an import replaces history, it saves one snapshot of
   kind `overwrite` in the same transaction. Its scope names the programs it touches and the
   lifter's choice: all history, all imported history, or a date range. The rows are what the
   overwrite removes, in the same payload format. A date range can also shorten a macrocycle or
   move a current macrocycle's dashboard date without removing it, so the payload has an
   `overwrite` field holding those rows as they were. A clear's payload has no such field. It
   expires after the same 30 days and the same job deletes it.
2. **No backup, no overwrite.** If the snapshot can't be saved, the transaction rolls back,
   nothing is removed or imported, and the response is a 503 with code `overwrite-backup-failed`.
   If the stored counts differ from the ones the lifter confirmed, it's a 409, as for a clear. A
   dry run saves no snapshot and rolls back.
3. **It comes back by undoing the import, not by a restore.** A Settings restore of an `overwrite`
   snapshot is refused with a 409 `overwrite-backup`: it would put the replaced history back beside
   the import that replaced it. Undoing the import removes its rows first, then puts the snapshot
   back with decision 3's rules, except that a shortened macrocycle still stored keeps its number
   and gets its dates, status and sets back. Then the snapshot is deleted.
4. **Undo needs its backup, and goes newest first.** Undo is refused with a 409
   `overwrite-undo-backup-gone` once the snapshot has expired or been deleted, since it would remove
   the import and restore nothing. Settings warns of this before a delete. It's refused with
   `overwrite-undo-later-overwrite` while a later overwrite's import is still stored, so two
   overwrites can't restore over each other.

## References

1. PostgreSQL 16 documentation, [§5.8 Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) — `FORCE ROW LEVEL SECURITY` makes policies apply to the table owner, and permissive policies for one command combine with `OR`.
2. PostgreSQL 16 documentation, [`CREATE POLICY`](https://www.postgresql.org/docs/16/sql-createpolicy.html) — `DELETE` policies need the row to be visible to a `SELECT` policy too when the statement reads its columns, which is why the job has both.
3. PostgreSQL 16 documentation, [`ALTER TABLE`](https://www.postgresql.org/docs/16/sql-altertable.html) — `FORCE ROW LEVEL SECURITY` and `NO FORCE` take an `ACCESS EXCLUSIVE` lock, the rejected alternative's cost.
4. PostgreSQL 16 documentation, [System Information Functions](https://www.postgresql.org/docs/16/functions-info.html) — `pg_get_userbyid` and `current_user`.
5. Prisma documentation, [`createMany`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany) — `skipDuplicates` inserts with `ON CONFLICT DO NOTHING`.
6. Google Cloud documentation, [Execute jobs](https://cloud.google.com/run/docs/execute/jobs) — `gcloud run jobs execute --wait` returns the execution's result.
7. Node.js documentation, [`zlib`](https://nodejs.org/api/zlib.html) — `gzip` and `gunzip`, which run on the thread pool rather than blocking the event loop.
8. PostgreSQL 16 documentation, [§13.2.2 Repeatable Read Isolation Level](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-REPEATABLE-READ) — the transaction sees a snapshot taken at its first statement, the rejected alternative's flaw; and [§13.3.2 Row-Level Locks](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS) — `FOR UPDATE` blocks other transactions' `UPDATE` and `DELETE` of the locked rows until it ends.
9. PostgreSQL 16 documentation, [§9.9.4 `AT TIME ZONE`](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-ZONECONVERT) — converting `timestamp with time zone` to the wall-clock `timestamp` of a zone.
