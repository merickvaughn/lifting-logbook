-- The expiry policies compare "expiresAt" in UTC (#1309, ADR-044).
--
-- "expiresAt" is TIMESTAMP(3), which Prisma writes as UTC wall-clock time with no zone. Comparing
-- it with now(), a timestamptz, casts the column using the session's TimeZone, so a session that
-- isn't UTC would see snapshots expire early or late by its offset. now() AT TIME ZONE 'UTC' is
-- the UTC wall-clock time, which compares with the column as written, in any session.
--
-- 20261115120000 created the policies with now() and may already be applied to staging, so this
-- replaces them rather than editing that migration.
--
-- Additive in effect: the same two policies, each comparing in UTC. Rollback is re-running
-- 20261115120000's two CREATE POLICY statements after dropping these.

SET LOCAL lock_timeout = '5s';

DROP POLICY "data_snapshot_expired_select" ON "data_snapshot";
DROP POLICY "data_snapshot_expired_delete" ON "data_snapshot";

CREATE POLICY "data_snapshot_expired_select" ON "data_snapshot" FOR SELECT
  USING (
    "expiresAt" <= (now() AT TIME ZONE 'UTC')
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = '"data_snapshot"'::regclass)
  );
CREATE POLICY "data_snapshot_expired_delete" ON "data_snapshot" FOR DELETE
  USING (
    "expiresAt" <= (now() AT TIME ZONE 'UTC')
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = '"data_snapshot"'::regclass)
  );
