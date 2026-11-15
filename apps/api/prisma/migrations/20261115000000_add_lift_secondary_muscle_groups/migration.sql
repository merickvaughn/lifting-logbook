-- Secondary muscle groups per lift (#1017, sub-issue 2 of #1013): the muscles a lift's working
-- sets count ½ toward. See docs/adr/ADR-036-muscle-group-defaults-and-fractional-set-counts.md.
-- A row whose `muscleGroups` and `secondaryMuscleGroups` are both empty means "use the
-- built-in defaults".
--
-- Additive only: the column has a constant default, which Postgres 11+ adds without rewriting
-- the table, and existing rows read as having no secondary muscles. It is nullable like the
-- table's other `TEXT[]` columns, because that is what Prisma generates for a scalar list, but
-- Prisma never writes null to one.
--
-- RLS: lift_metadata already has forced row-level security by userId
-- (lift_metadata_user_isolation), and a new column inherits the table's policies.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes the column.
--
-- Rollback: the old API ignores the column, so the database needs no change. Roll the web back
-- with the API, or first: the new web sends `secondaryMuscleGroups`, which the old API rejects
-- as unknown (forbidNonWhitelisted), so lift editor saves would fail. Dropping the column loses
-- the secondary muscles lifters have set.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "lift_metadata" ADD COLUMN     "secondaryMuscleGroups" TEXT[] DEFAULT ARRAY[]::TEXT[];
