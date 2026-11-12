-- Keeps one list of the tables the renumbering turns FORCE ROW LEVEL SECURITY off for (#1200,
-- PR #1231 eleventh review). 20261112000003's `macrocycle_set_forced_rls` and
-- 20261112000005's guard in `macrocycle_lock_every_user` each named the nine tables, with
-- nothing keeping the two lists in step: a table added to the switch but not the guard would let
-- a step run while that table still hid its rows.
--
-- `macrocycle_forced_tables()` is now the list. The switch iterates it, and the guard asks
-- `row_security_active()` of each table in it, which is true when row-level security applies to
-- the current user: false for a superuser, a BYPASSRLS role, or an owner with FORCE off. That
-- replaces the guard's own reading of `pg_roles` and `relforcerowsecurity`.
--
-- A new migration because staging has applied 20261112000005; later changes go in new ones too.

CREATE FUNCTION "macrocycle_forced_tables"() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['macrocycle', 'lift_record', 'macrocycle_dashboard', 'workout_date_override',
               'workout_skip_override', 'workout_lift_override', 'focus_day_state',
               'macrocycle_scheduled_workout', 'import_batch']
$$;

-- Unchanged from 20261112000003 but for reading the list.
CREATE OR REPLACE FUNCTION "macrocycle_set_forced_rls"(forced BOOLEAN) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY "macrocycle_forced_tables"()
  LOOP
    EXECUTE format('ALTER TABLE %I %s FORCE ROW LEVEL SECURITY', t, CASE WHEN forced THEN '' ELSE 'NO' END);
  END LOOP;
END;
$$;

-- Unchanged from 20261112000005 but for the check at the top.
CREATE OR REPLACE FUNCTION "macrocycle_lock_every_user"(only_user TEXT, wait_for_locks BOOLEAN DEFAULT true) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  owner_id TEXT;
  hidden TEXT;
BEGIN
  SELECT t INTO hidden FROM unnest("macrocycle_forced_tables"()) AS t
  WHERE row_security_active(format('%I', t)::regclass) LIMIT 1;
  IF hidden IS NOT NULL THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY is on for %, so % sees no rows; call a macrocycle_runbook_* function instead',
      hidden, current_user;
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

REVOKE EXECUTE ON FUNCTION "macrocycle_forced_tables"() FROM PUBLIC;

COMMENT ON FUNCTION "macrocycle_forced_tables"() IS
  'The tables macrocycle_set_forced_rls switches and macrocycle_lock_every_user checks: every table the renumbering steps read or write.';
COMMENT ON FUNCTION "macrocycle_lock_every_user"(TEXT, BOOLEAN) IS
  'Takes every user''s macrocycle lock, or only_user''s. Raises an error when row-level security applies to the caller on any of macrocycle_forced_tables(). wait_for_locks => false skips held locks, which is safe only while the caller holds the nine tables (macrocycle_set_forced_rls(false) or an ALTER TABLE on them): then a request holding a lock has not used the tables, and waiting on it would deadlock.';
