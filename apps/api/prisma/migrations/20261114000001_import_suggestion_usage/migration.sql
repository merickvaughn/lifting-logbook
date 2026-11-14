-- Import suggestion requests per user (#1174, proposal decision 12): one row per request that
-- reached an LLM provider, so the 10-per-hour limit holds across API instances.
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
CREATE TABLE "import_suggestion_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_suggestion_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_suggestion_usage_userId_usedAt_idx" ON "import_suggestion_usage"("userId", "usedAt");

-- EnableRLS
ALTER TABLE "import_suggestion_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_suggestion_usage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "import_suggestion_usage_user_isolation" ON "import_suggestion_usage"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
