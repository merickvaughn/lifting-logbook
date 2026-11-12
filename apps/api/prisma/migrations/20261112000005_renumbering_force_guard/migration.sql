-- Makes a renumbering step refuse when it can't see the rows, and narrows what the runbook's
-- report holds (#1200, PR #1231 tenth review). A new migration because staging has applied
-- 20261112000004; later changes to these functions go in new migrations too.
--
-- 1. `macrocycle_lock_every_user` raises an error when a caller that FORCE ROW LEVEL SECURITY
--    binds calls it with FORCE on. `macrocycle_close_window_rows`, `macrocycle_renumber_by_date`
--    and `macrocycle_renumber_reverse` call it first, so a direct call by the migrator, which owns
--    the tables but isn't superuser or BYPASSRLS, now fails instead of returning 0 with a notice
--    that reads as success, the silent no-op 20261112000003 fixed. The `macrocycle_runbook_*`
--    functions and 20261112000003 turn FORCE off before they call it, so they're unaffected. A
--    superuser, such as the DB e2e suite's owner, isn't bound and passes.
-- 2. `macrocycle_runbook_report` reads only "macrocycle" and "macrocycle_dashboard", so it turns
--    FORCE off on those two alone rather than holding all nine tables.
-- 3. Comments on the functions say when `wait_for_locks => false` is safe: only while the caller
--    holds the nine tables, as 20261112000003 and the runbook functions do. 20261112000004's
--    header says the runbook functions take locks; the report takes none.

-- Unchanged from 20261112000001 but for the check at the top.
CREATE OR REPLACE FUNCTION "macrocycle_lock_every_user"(only_user TEXT, wait_for_locks BOOLEAN DEFAULT true) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  owner_id TEXT;
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (SELECT 1 FROM pg_class
                 WHERE oid = ANY (ARRAY['"macrocycle"'::regclass, '"lift_record"'::regclass, '"macrocycle_dashboard"'::regclass,
                                        '"workout_date_override"'::regclass, '"workout_skip_override"'::regclass,
                                        '"workout_lift_override"'::regclass, '"focus_day_state"'::regclass,
                                        '"macrocycle_scheduled_workout"'::regclass, '"import_batch"'::regclass])
                   AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY is on, so % sees no rows; call a macrocycle_runbook_* function instead', current_user;
  END IF;
  FOR owner_id IN
    SELECT u FROM (
      SELECT "userId" AS u FROM "macrocycle"
      UNION SELECT "userId" FROM "lift_record"
      UNION SELECT "userId" FROM "macrocycle_dashboard"
      UNION SELECT "userId" FROM "workout_date_override"
      UNION SELECT "userId" FROM "workout_skip_override"
      UNION SELECT "userId" FROM "workout_lift_override"
      UNION SELECT "userId" FROM "focus_day_state"
      UNION SELECT "userId" FROM "macrocycle_scheduled_workout"
    ) AS owners
    WHERE only_user IS NULL OR u = only_user
    ORDER BY 1
  LOOP
    IF wait_for_locks THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 1171));
    ELSIF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id, 1171)) THEN
      RAISE NOTICE 'Skipped the macrocycle lock of user %, held by a request waiting on the table', owner_id;
    END IF;
  END LOOP;
END;
$$;

-- Same columns as 20261112000004's, with FORCE turned off on the two tables it reads.
CREATE OR REPLACE FUNCTION "macrocycle_runbook_report"()
RETURNS TABLE (renumbered BIGINT, open_live_off_dashboard BIGINT, recorded BIGINT, closed JSONB)
LANGUAGE plpgsql AS $$
BEGIN
  ALTER TABLE "macrocycle" NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE "macrocycle_dashboard" NO FORCE ROW LEVEL SECURITY;
  RETURN QUERY SELECT
    (SELECT count(*) FROM "macrocycle" WHERE "backfillNumber" IS NOT NULL AND "macrocycleNum" <> "backfillNumber"),
    (SELECT count(*) FROM "macrocycle" m WHERE m."origin" = 'live' AND m."status" = 'in-progress' AND m."endDate" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "macrocycle_dashboard" d
                       WHERE d."userId" = m."userId" AND d."program" = m."program" AND d."macrocycleNum" = m."macrocycleNum")),
    (SELECT count(*) FROM "macrocycle" WHERE "backfilledAt" IS NOT NULL),
    (SELECT coalesce(jsonb_agg(jsonb_build_object('userId', "userId", 'program', "program", 'macrocycleNum', "macrocycleNum",
                                                  'status', "status", 'endDate', "endDate")
                               ORDER BY "userId", "program", "macrocycleNum"), '[]'::jsonb)
     FROM "macrocycle" WHERE "backfillClosedAt" IS NOT NULL);
  ALTER TABLE "macrocycle" FORCE ROW LEVEL SECURITY;
  ALTER TABLE "macrocycle_dashboard" FORCE ROW LEVEL SECURITY;
END;
$$;

COMMENT ON FUNCTION "macrocycle_lock_every_user"(TEXT, BOOLEAN) IS
  'Takes every user''s macrocycle lock, or only_user''s. Raises an error when FORCE ROW LEVEL SECURITY is on and binds the caller. wait_for_locks => false skips held locks, which is safe only while the caller holds the nine tables (macrocycle_set_forced_rls(false) or an ALTER TABLE on them): then a request holding a lock has not used the tables, and waiting on it would deadlock.';
COMMENT ON FUNCTION "macrocycle_close_window_rows"(TEXT, BOOLEAN) IS
  'Closes live rows the old revision left open. wait_for_locks => false only while the caller holds the nine tables; see macrocycle_lock_every_user.';
COMMENT ON FUNCTION "macrocycle_renumber_by_date"(TEXT, BOOLEAN) IS
  'Renumbers by start date, recording old numbers. The runbook calls it through macrocycle_runbook_renumber(). wait_for_locks => false only while the caller holds the nine tables; see macrocycle_lock_every_user.';
COMMENT ON FUNCTION "macrocycle_renumber_reverse"(TEXT, BOOLEAN) IS
  'Puts back the recorded numbers. The runbook calls it through macrocycle_runbook_reverse(). wait_for_locks => false only while the caller holds the nine tables; see macrocycle_lock_every_user.';
COMMENT ON FUNCTION "macrocycle_runbook_report"() IS
  'What the renumbering changed. Turns FORCE off on macrocycle and macrocycle_dashboard while it reads them, and takes no advisory locks.';
