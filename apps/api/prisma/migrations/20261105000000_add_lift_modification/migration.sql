-- Lift modifications (#1151): a user-defined change to how a lift is performed, and which were on
-- for each logged set. See docs/adr/ADR-041-lift-modification-storage.md.
--
-- Additive only. Adding a column with a constant default does not rewrite "lift_record" (Postgres
-- 11+), so existing rows read as unmodified at once and need no backfill.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes either object, so the window is harmless.
--
-- Rollback: reverting the API image alone is safe. The old code ignores the column, and a set it
-- writes takes the empty default. Dropping the column and the table loses the modifications
-- recorded so far, so leave them in place unless that is intended.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "lift_record" ADD COLUMN     "modifications" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "lift_modification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lift" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "maxMode" TEXT NOT NULL DEFAULT 'none',
    "alternativeNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lift_modification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lift_modification_userId_lift_name_key" ON "lift_modification"("userId", "lift", "name");

-- AddConstraint: mirrors LIFT_MODIFICATION_MAX_MODES in packages/types/src/domain.ts.
ALTER TABLE "lift_modification"
  ADD CONSTRAINT "lift_modification_max_mode_check" CHECK ("maxMode" IN ('none', 'lift', 'own'));

-- EnableRLS
ALTER TABLE "lift_modification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lift_modification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "lift_modification_user_isolation" ON "lift_modification"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
