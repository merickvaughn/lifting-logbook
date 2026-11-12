-- A lift modification's own training max (#1153): the max a modification with `maxMode` `own`
-- plans from and moves, scoped to a program like "training_max". See the lift modifications
-- proposal (docs/proposals/2026-11-05-lift-modifications.md) and ADR-041.
--
-- Additive only. The new history column is nullable with no default, so existing rows read as the
-- lift's own history at once and need no backfill.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes the table or the column, so the window is
-- harmless.
--
-- Rollback: reverting the API image alone is safe. The old code ignores both, and its history
-- reads would then include own-max rows, which only an own `updateMaxes` save writes. Dropping
-- the table and column loses the own maxes recorded so far, so leave them in place unless that is
-- intended.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "training_max_history" ADD COLUMN     "modificationId" TEXT;

-- CreateTable
CREATE TABLE "lift_modification_max" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "modificationId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "dateUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lift_modification_max_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lift_modification_max_userId_program_modificationId_key" ON "lift_modification_max"("userId", "program", "modificationId");

-- AddForeignKey: deleting a modification takes its own maxes with it.
ALTER TABLE "lift_modification_max" ADD CONSTRAINT "lift_modification_max_modificationId_fkey" FOREIGN KEY ("modificationId") REFERENCES "lift_modification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EnableRLS
ALTER TABLE "lift_modification_max" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lift_modification_max" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lift_modification_max_user_isolation" ON "lift_modification_max"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
