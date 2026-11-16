-- Snapshots of a user's training data, taken before Clear data removes it (#1309, proposal
-- decisions 20 and 21, ADR-044). One row per action, kept 30 days.
--
-- Additive only: a new table, which nothing else references.
--
-- Row-level security is forced, as on every user table, so the API role sees only the current
-- user's rows. Two more policies let the table's owner, the migration role, read and delete rows
-- past their expiry and nothing else. The daily expiry job connects as that role. The owner
-- isn't a superuser or BYPASSRLS, so FORCE binds it too, and with no user set the isolation
-- policy hides every row from it (see 20261112000003). The owner is read from the catalog, so
-- the policies hold whichever role ran this migration.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old API neither reads nor writes the table, so the window is harmless.
--
-- Rollback: reverting the API image alone is safe; the old code ignores the table. Dropping it
-- loses every unexpired snapshot, which is cleared data a lifter can no longer restore, so leave
-- it in place unless that is intended.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "data_snapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "rows" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_snapshot_userId_createdAt_idx" ON "data_snapshot"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "data_snapshot_expiresAt_idx" ON "data_snapshot"("expiresAt");

-- EnableRLS
ALTER TABLE "data_snapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "data_snapshot" FORCE ROW LEVEL SECURITY;
CREATE POLICY "data_snapshot_user_isolation" ON "data_snapshot"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- The expiry job's route through row-level security: the owner sees and deletes expired rows.
CREATE POLICY "data_snapshot_expired_select" ON "data_snapshot" FOR SELECT
  USING (
    "expiresAt" <= now()
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = '"data_snapshot"'::regclass)
  );
CREATE POLICY "data_snapshot_expired_delete" ON "data_snapshot" FOR DELETE
  USING (
    "expiresAt" <= now()
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = '"data_snapshot"'::regclass)
  );
