-- Progression type per lift (#1210, phase 2 of #1206): where a lift's own progression, the
-- lifter's default, and a program spec row's override are stored. See
-- docs/adr/ADR-043-lift-progression-resolution-and-storage.md.
--
-- Additive only: every column is nullable with no default, so adding them does not rewrite a
-- table. Nothing reads them to move a training max until #1211, so the values stored here
-- change no behaviour yet. The backfill that keeps existing custom programs on today's rule is
-- the next migration, 20261111000001_backfill_custom_spec_progression.
--
-- RLS: all three tables already have forced row-level security (lift_metadata and
-- user_settings by userId, custom_program_spec through its parent program), and new columns
-- inherit the table's policies.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes these columns.
--
-- Rollback: the old API ignores the columns, so the database needs no change. Roll the web back
-- with the API, or first: the new web sends the progression fields, which the old API rejects
-- as unknown (forbidNonWhitelisted), so its lift and custom program saves would fail. Dropping
-- the columns loses the values lifters have set, so leave them in place unless that is intended.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "lift_metadata" ADD COLUMN     "progression" TEXT,
ADD COLUMN     "progressionIncrement" DOUBLE PRECISION,
ADD COLUMN     "repsHigh" INTEGER,
ADD COLUMN     "repsLow" INTEGER;

-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "defaultProgression" TEXT,
ADD COLUMN     "defaultProgressionIncrement" DOUBLE PRECISION,
ADD COLUMN     "defaultProgressionRepsHigh" INTEGER,
ADD COLUMN     "defaultProgressionRepsLow" INTEGER;

-- AlterTable
ALTER TABLE "custom_program_spec" ADD COLUMN     "progression" TEXT,
ADD COLUMN     "repsLow" INTEGER;
