-- Bring `occurrence` into the LiftRecord natural-key unique constraint (issue #1027).
--
-- A program can plan one lift twice in a workout day (two spec rows, ADR-035
-- Amendment 4), and each occurrence logs its own sets. Keyed by lift name alone,
-- the second occurrence's set 1 collided with the first's. `occurrence` numbers a
-- lift's occurrences in its workout from 0, in plan order.
--
-- No backfill: before this, a workout could log only one occurrence of a lift, so
-- every existing row is occurrence 0, the column default. Adding a NOT NULL column
-- with a constant default does not rewrite the table (Postgres 11+).
--
-- DROP before CREATE, unlike 20260818120000: Prisma truncates the index name to 63
-- characters, so the old and new keys share one name. Both statements run inside
-- Prisma's per-migration transaction, so there is no window with neither index.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API
-- revision (ADR-027). Rolling the API image back alone is safe until a second
-- occurrence is logged: the old code never writes `occurrence`, so its rows stay 0.
-- After that, the old code's update-by-key can match both occurrences' rows of one
-- set. Reverting this index needs every occurrence > 0 row deleted first.

SET LOCAL lock_timeout = '5s';

-- DropIndex
DROP INDEX "lift_record_userId_program_macrocycleNum_workoutNum_date_li_key";

-- AlterTable
ALTER TABLE "lift_record" ADD COLUMN     "occurrence" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "lift_record_userId_program_macrocycleNum_workoutNum_date_li_key" ON "lift_record"("userId", "program", "macrocycleNum", "workoutNum", "date", "lift", "occurrence", "setNum");
