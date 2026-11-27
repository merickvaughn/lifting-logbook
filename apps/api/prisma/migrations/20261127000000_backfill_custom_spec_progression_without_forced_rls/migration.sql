-- Repeat the custom program progression backfill where row-level security hid every row from it
-- (#1236; #1210, docs/adr/ADR-043-lift-progression-resolution-and-storage.md).
--
-- 20261111000001_backfill_custom_spec_progression tagged null `progression` rows `amrap_gated`.
-- The migrate job connects as the migrator, `lifting-logbook-app`, which owns the tables but is
-- neither a superuser nor BYPASSRLS, and `custom_program_spec` has FORCE ROW LEVEL SECURITY, which
-- binds the owner too. With `app.current_user_id` unset its policy matches no row, so that UPDATE
-- changed nothing and still succeeded (docs/deploy.md, "Row-Level Security cutover").
--
-- This migration turns FORCE off on the two tables the UPDATE reads, so their owner sees every
-- row, repeats it, and turns FORCE back on. Prisma Migrate sends the file as one query string,
-- which PostgreSQL runs as one transaction, so a failure leaves FORCE on and changes nothing, as
-- 20261111120000 and 20261112000003 rely on.
--
-- Which rows. A row created after 20261111000001 may be null on purpose, to follow the lift, so
-- only rows of a program created before that migration started are tagged. A spec row has no
-- timestamp of its own, and saving a program replaces its rows, so the program's "createdAt" is
-- the nearest. "createdAt" is a UTC timestamp without a zone, so the start time is read in UTC.
-- A lifter who, since that migration, deliberately cleared a row of an older program to follow
-- the lift gets `amrap_gated` back: the editor showed every missed row blank, so nothing stored
-- tells that choice apart from a row the backfill missed. Where 20261111000001 isn't recorded as applied the
-- start time is null and nothing is tagged. Where it did see the rows, such as a database whose
-- migrator is a superuser, they are no longer null and nothing changes.
--
-- Locks. Turning FORCE off takes an ACCESS EXCLUSIVE lock on each table until the migration
-- commits, so reads of custom programs wait for this one UPDATE.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "custom_program" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "custom_program_spec" NO FORCE ROW LEVEL SECURITY;

UPDATE "custom_program_spec" AS s
SET "progression" = 'amrap_gated'
FROM "custom_program" AS p
WHERE s."programId" = p."id"
  AND s."progression" IS NULL
  AND p."createdAt" < (
    SELECT MIN(m."started_at") AT TIME ZONE 'UTC'
    FROM "_prisma_migrations" AS m
    WHERE m."migration_name" = '20261111000001_backfill_custom_spec_progression'
      AND m."finished_at" IS NOT NULL
      AND m."rolled_back_at" IS NULL
  );

ALTER TABLE "custom_program_spec" FORCE ROW LEVEL SECURITY;

ALTER TABLE "custom_program" FORCE ROW LEVEL SECURITY;
