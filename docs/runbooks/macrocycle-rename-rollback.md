# Runbook: Roll back the macrocycle rename

**Triggers:** either of:
- A decision to revert [PR #1041](https://github.com/merickvaughn/lifting-logbook/pull/1041) ([ADR-038](../adr/ADR-038-training-time-vocabulary.md)) after its migration `20261009000000_rename_cycle_to_macrocycle` has run.
- That PR being closed without merging after its staging run migrated the shared staging database.

**Default severity:** SEV2. Every DB-backed route returns 500 until the schema and the code agree again.
**Dashboard:** Grafana → API overview (5xx by `http_route`)

---

## Symptom

- The API returns 500 on every DB-backed route. Its logs show Prisma errors naming a table or
  column that "does not exist":
  - `cycle_dashboard` / `cycleNum` when old code runs against the renamed schema;
  - `macrocycle_dashboard` / `macrocycleNum` when new code runs against the old schema.
- `/readyz` stays green. It runs only `SELECT 1`, so the deploy smoke test does not catch this.

## Likely causes

1. **Old code deployed against the renamed schema.** Reverting PR #1041 alone is not enough.
   On a branch that lacks `20261009000000_rename_cycle_to_macrocycle`,
   `prisma migrate deploy && prisma migrate status` reports "Database schema is up to date!" even
   though the database has that migration applied. The revert therefore passes the migrate job and
   deploys code that queries tables that no longer exist.
2. **The planned deploy windows** (expected, and short). `deploy.yml` runs migrate → API → web,
   which opens two windows:
   - **Migrate job → new API revision.** The *old* API queries the renamed tables, so every DB
     route returns 500, and `ApiRouteHighErrorRate` may fire.
   - **New API → new web revision.** The *old* web calls the deleted `/programs/:program/cycles/*`
     routes. `requestNullable` turns the 404 into `null`, and the old `/cycle` page redirects to
     `/onboarding`. These are 404s, so no 5xx alert fires.
     **Don't complete onboarding during this window:** it would overwrite the stored training maxes.

   New code never runs against an unmigrated database in this pipeline.

## Diagnosis

```sql
-- Which shape is the database in?
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE '%cycle%';
SELECT migration_name, finished_at FROM "_prisma_migrations"
WHERE migration_name LIKE '%cycle%' ORDER BY finished_at;
```

Compare the result with the API image tag that is running (see [Checking the deployed version](checking-deployed-version.md)).

## Remediation

### Revert in production (and staging)

Ship the rollback as a **forward migration in the revert PR**. The pipeline runs migrations before
deploying code, so the schema is renamed back before the old code starts, in staging and production
alike:

1. Revert PR #1041 on a branch, but **keep**
   `apps/api/prisma/migrations/20261009000000_rename_cycle_to_macrocycle/` in the tree. Prisma
   requires every applied migration to still exist.
2. Restore `schema.prisma` to the pre-rename models. The revert does this.
3. Add `apps/api/prisma/migrations/<timestamp>_rename_macrocycle_to_cycle/migration.sql` containing
   the SQL below. Use a timestamp later than every existing migration.
4. Check it with
   `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <scratch db>`.
   It must report an empty migration.
5. Open the revert PR. Staging and production apply the forward migration ahead of the old code.

### PR #1041 closed without merging

Its staging run already migrated the shared staging database, so every other PR's staging deploy
fails until that is undone.
1. Run the SQL below against staging as the owner role.
2. Delete the record of the abandoned migration, so Prisma stops expecting it:

```sql
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261009000000_rename_cycle_to_macrocycle';
```

### Reverse SQL

This is the exact inverse of `20261009000000_rename_cycle_to_macrocycle`: the same statements in
reverse order. Like the forward migration, it only renames. No data moves, and RLS, policies and
grants stay attached to each table.

```sql
ALTER INDEX "workout_lift_override_userId_program_macrocycleNum_workoutN_key" RENAME TO "workout_lift_override_userId_program_cycleNum_workoutNum_li_key";
ALTER INDEX "workout_lift_override_userId_program_macrocycleNum_workoutN_idx" RENAME TO "workout_lift_override_userId_program_cycleNum_workoutNum_idx";
ALTER TABLE "workout_lift_override" RENAME COLUMN "macrocycleNum" TO "cycleNum";
ALTER INDEX "workout_skip_override_userId_program_macrocycleNum_workoutN_key" RENAME TO "workout_skip_override_userId_program_cycleNum_workoutNum_key";
ALTER INDEX "workout_skip_override_userId_program_macrocycleNum_idx" RENAME TO "workout_skip_override_userId_program_cycleNum_idx";
ALTER TABLE "workout_skip_override" RENAME COLUMN "macrocycleNum" TO "cycleNum";
ALTER INDEX "workout_date_override_userId_program_macrocycleNum_workoutN_key" RENAME TO "workout_date_override_userId_program_cycleNum_workoutNum_key";
ALTER INDEX "workout_date_override_userId_program_macrocycleNum_idx" RENAME TO "workout_date_override_userId_program_cycleNum_idx";
ALTER TABLE "workout_date_override" RENAME COLUMN "macrocycleNum" TO "cycleNum";
ALTER INDEX "lift_record_userId_program_macrocycleNum_workoutNum_date_li_key" RENAME TO "lift_record_userId_program_cycleNum_workoutNum_date_lift_se_key";
ALTER INDEX "lift_record_userId_program_macrocycleNum_workoutNum_idx" RENAME TO "lift_record_userId_program_cycleNum_workoutNum_idx";
ALTER INDEX "lift_record_userId_program_macrocycleNum_idx" RENAME TO "lift_record_userId_program_cycleNum_idx";
ALTER TABLE "lift_record" RENAME COLUMN "macrocycleNum" TO "cycleNum";
ALTER POLICY "macrocycle_scheduled_workout_user_isolation" ON "macrocycle_scheduled_workout" RENAME TO "cycle_scheduled_workout_user_isolation";
ALTER INDEX "macrocycle_scheduled_workout_userId_program_macrocycleNum_w_key" RENAME TO "cycle_scheduled_workout_userId_program_cycleNum_workoutNum_key";
ALTER INDEX "macrocycle_scheduled_workout_userId_program_macrocycleNum_idx" RENAME TO "cycle_scheduled_workout_userId_program_cycleNum_idx";
ALTER TABLE "macrocycle_scheduled_workout" RENAME CONSTRAINT "macrocycle_scheduled_workout_pkey" TO "cycle_scheduled_workout_pkey";
ALTER TABLE "macrocycle_scheduled_workout" RENAME COLUMN "macrocycleNum" TO "cycleNum";
ALTER TABLE "macrocycle_scheduled_workout" RENAME TO "cycle_scheduled_workout";
ALTER POLICY "macrocycle_dashboard_user_isolation" ON "macrocycle_dashboard" RENAME TO "cycle_dashboard_user_isolation";
ALTER INDEX "macrocycle_dashboard_userId_program_key" RENAME TO "cycle_dashboard_userId_program_key";
ALTER INDEX "macrocycle_dashboard_userId_program_idx" RENAME TO "cycle_dashboard_userId_program_idx";
ALTER TABLE "macrocycle_dashboard" RENAME CONSTRAINT "macrocycle_dashboard_pkey" TO "cycle_dashboard_pkey";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "macrocycleStartWeekday" TO "cycleStartWeekday";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "macrocycleDate" TO "cycleDate";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "macrocycleNum" TO "cycleNum";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "macrocycleUnit" TO "cycleUnit";
ALTER TABLE "macrocycle_dashboard" RENAME TO "cycle_dashboard";
```

## Escalation

This is a single-user app, so there is no external escalation. Prisma runs each migration in a
transaction, so the forward migration should not fail partway. If it does, restore from the Cloud
SQL automated backup taken before the deploy (see [Database unreachable](database-unreachable.md)
for access).
