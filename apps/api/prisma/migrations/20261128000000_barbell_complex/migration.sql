-- Barbell complex definitions (#1495): a user's complexes, each a name and its components in order
-- (`[{ lift, reps }]`). A program row plans one as `complex:<id>`. See
-- docs/proposals/2026-11-27-barbell-complexes.md.
--
-- Additive only: a new table, which no existing row refers to.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes the table, so the window is harmless.
--
-- Rollback: reverting the API image alone is safe. The old code ignores the table, and plans a
-- `complex:<id>` row as a lift with no training max. Dropping the table loses the complexes defined
-- so far, so leave it in place unless that is intended.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "barbell_complex" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "barbell_complex_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "barbell_complex_userId_name_key" ON "barbell_complex"("userId", "name");

-- EnableRLS
ALTER TABLE "barbell_complex" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "barbell_complex" FORCE ROW LEVEL SECURITY;
CREATE POLICY "barbell_complex_user_isolation" ON "barbell_complex"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
