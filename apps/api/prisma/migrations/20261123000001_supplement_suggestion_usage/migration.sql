-- Supplement AI suggestion requests per user (#1381): one row per request that
-- reached an LLM provider, so the 20-per-hour limit holds across API instances.
--
-- Additive only: a new table, which nothing else references.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes the table, so the window is harmless.
--
-- Rollback: reverting the API image alone is safe; the old code ignores the table. Dropping it
-- only resets the hourly counts.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "supplement_suggestion_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplement_suggestion_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplement_suggestion_usage_userId_usedAt_idx" ON "supplement_suggestion_usage"("userId", "usedAt");

-- EnableRLS
ALTER TABLE "supplement_suggestion_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplement_suggestion_usage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "supplement_suggestion_usage_user_isolation" ON "supplement_suggestion_usage"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
