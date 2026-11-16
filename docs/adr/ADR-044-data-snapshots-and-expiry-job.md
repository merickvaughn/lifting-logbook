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
   payload carries a version. The table has the usual forced isolation policy.
2. **The snapshot covers exactly what Clear removes.** That's decision 20's eleven tables plus
   `lift_modification_max`, the own maxes of lift modifications, which the owner chose to clear.
   `missing_max_dismissal` stays, also the owner's choice. The snapshot is saved, then the tables
   are cleared, in one transaction that holds the import and macrocycle locks. If the save fails,
   the transaction rolls back and nothing is cleared. If the stored counts differ from the ones the
   lifter confirmed, nothing happens and the response is a 409.
3. **Restore inserts only what's missing, then renumbers.** For each program, the snapshot's
   macrocycle numbers move past every number stored now, in every numbered table and in
   lift-record import pre-images. Then each row goes in unless a stored row holds its key:
   `createMany` with `skipDuplicates` in Postgres. So a program's dashboard, a lift's training max
   and a modification's own max saved since the clear are kept. When the dashboard is kept, the
   snapshot's current macrocycle comes back closed, as starting the next macrocycle closes one.
   Non-cycle workouts share one macrocycle that is never renumbered, so their workout numbers move
   past the logged ones instead. Each program is then renumbered by start date (ADR-042), and the
   snapshot is deleted. A restore can't run twice.
4. **Every read treats an expired snapshot as gone.** List, restore and download filter on
   `expiresAt > now`, so a late or failed job never extends retention.
5. **The expiry job reaches expired rows through two owner-only policies.** `data_snapshot` has a
   `SELECT` policy and a `DELETE` policy, each `USING ("expiresAt" <= now() AND current_user =
   <the table's owner>)`. The owner is read from `pg_class`, so the policies hold whichever role
   ran the migration. Policies of one command combine with `OR`, so the API role still sees only
   the current user's rows. The job is a script in the API image, run as a Cloud Run job with the
   migrator connection. It checks that it runs as the table's owner, deletes rows up to one cutoff,
   counts what's left up to the same cutoff, logs both as JSON, and exits non-zero when it isn't
   the owner or a row is left. A daily workflow executes it, as `deploy.yml` executes the migrate
   job.

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
- **Store snapshots as rows in shadow copies of each table.** Rejected: twelve more tables to keep
  in step with every schema change, where one compressed payload with a version needs nothing.
- **Restore by overwriting.** Rejected by decision 21's own wording: restore must not lose anything
  saved since the clear.

## Consequences

- A restore can bring back a training max for a lift that has none now, beside newer maxes for
  other lifts. That's the "missing only" rule, not a merge of values.
- A restored import batch keeps working for undo, because its pre-image keys move with the
  macrocycle numbers. A batch's non-cycle keys hold no number, so they don't move with non-cycle
  workout numbers.
- The expiry policies give the migrator read and delete access to expired snapshots of every user.
  The migrator already owns the table and could drop it, so this grants nothing it couldn't take.
- Overwrite with a fresh import (the proposal's overwrite criteria) can reuse the table and payload
  with another `kind` and a narrower scope.

## References

1. PostgreSQL 16 documentation, [§5.8 Row Security Policies](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) — `FORCE ROW LEVEL SECURITY` makes policies apply to the table owner, and permissive policies for one command combine with `OR`.
2. PostgreSQL 16 documentation, [`CREATE POLICY`](https://www.postgresql.org/docs/16/sql-createpolicy.html) — `DELETE` policies need the row to be visible to a `SELECT` policy too when the statement reads its columns, which is why the job has both.
3. PostgreSQL 16 documentation, [`ALTER TABLE`](https://www.postgresql.org/docs/16/sql-altertable.html) — `FORCE ROW LEVEL SECURITY` and `NO FORCE` take an `ACCESS EXCLUSIVE` lock, the rejected alternative's cost.
4. PostgreSQL 16 documentation, [System Information Functions](https://www.postgresql.org/docs/16/functions-info.html) — `pg_get_userbyid` and `current_user`.
5. Prisma documentation, [`createMany`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany) — `skipDuplicates` inserts with `ON CONFLICT DO NOTHING`.
6. Google Cloud documentation, [Execute jobs](https://cloud.google.com/run/docs/execute/jobs) — `gcloud run jobs execute --wait` returns the execution's result.
7. Node.js documentation, [`zlib`](https://nodejs.org/api/zlib.html) — `gzipSync` and `gunzipSync`.
