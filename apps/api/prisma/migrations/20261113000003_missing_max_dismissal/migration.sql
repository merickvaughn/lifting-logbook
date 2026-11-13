-- "Don't ask again" on the offer to set up a training max for a lift with logged sets and none
-- (#1246, #1270): one row per user, program and lift, keyed by the lift's stable id (#1139).
--
-- Additive only: a new table, which nothing else references.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes the table, so the window is harmless.
--
-- Rollback: reverting the API image alone is safe; the old code ignores the table. Dropping it
-- loses the lifters' "Don't ask again" answers, so leave it in place unless that is intended.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "missing_max_dismissal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "liftId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_max_dismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "missing_max_dismissal_userId_program_liftId_key" ON "missing_max_dismissal"("userId", "program", "liftId");

-- EnableRLS
ALTER TABLE "missing_max_dismissal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "missing_max_dismissal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "missing_max_dismissal_user_isolation" ON "missing_max_dismissal"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
