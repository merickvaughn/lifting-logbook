-- Run the macrocycle backfill and renumbering where row-level security hid every row from them
-- (#1200, PR #1231 review; docs/adr/ADR-042-macrocycle-table-and-numbering.md).
--
-- The migrate job connects as the migrator, `lifting-logbook-app`, which owns the tables but is
-- neither a superuser nor BYPASSRLS: on staging, `rolsuper` and `rolbypassrls` are both false
-- for it, and its cloudsqlsuperuser membership doesn't pass either on. Every table here has FORCE ROW LEVEL SECURITY, which binds the owner too, and
-- with `app.current_user_id` unset its policies match no row. So 20261110000000 (#1197) and
-- 20261112000001 (#1200) both ran and read nothing: on staging the migrator counted 0 lift
-- records where the planner estimated 216. Production has the same roles (infra/terraform).
--
-- This migration turns FORCE off on the nine tables the functions read and write, so their owner
-- sees every row, runs the steps 20261112000001 runs, and turns FORCE back on. The app role,
-- `lifting_app`, isn't the owner, so RLS filters it throughout. Prisma Migrate sends the file as
-- one query string, which PostgreSQL runs as one transaction, so a failure leaves FORCE on and
-- changes nothing, as 20261111120000 relies on for "focus_block".
--
-- The steps run only if no macrocycle has been renumbered yet ("backfilledAt" unset everywhere),
-- so a database where the earlier migrations did see the rows, such as one whose migrator is a
-- superuser, isn't processed twice. `macrocycle_backfill_window_rows()` repeats the #1197
-- backfill, so it fills the history rows that migration missed.
--
-- Locks. Turning FORCE off takes an ACCESS EXCLUSIVE lock on each table, waiting for every
-- transaction that has used it, and blocks every later read of it until the migration commits.
-- The steps then take each user's macrocycle lock without waiting, as in 20261112000001: a request
-- holding one now can't have used any of the nine tables, or the ALTER TABLE would have waited
-- for it, so it waits on the tables and reads the committed numbers. Skipping its lock doesn't
-- skip the user, whose rows the steps renumber with everyone else's. A request that used one of
-- the tables and then waits on another this migration already holds is a deadlock, which
-- PostgreSQL resolves by aborting one of the two; if it's the migration, it fails like a lock
-- timeout (docs/deploy.md, "If the renumbering migration fails").
--
-- `macrocycle_set_forced_rls()` is the switch, kept for the runbook: reading or reversing the
-- renumbering as the migrator needs FORCE off too.

SET LOCAL lock_timeout = '40s';

-- Turns FORCE ROW LEVEL SECURITY on or off for the nine tables the macrocycle backfill,
-- renumbering and reversal read and write. Every one of them has FORCE on outside this switch.
CREATE FUNCTION "macrocycle_set_forced_rls"(forced BOOLEAN) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['macrocycle', 'lift_record', 'macrocycle_dashboard', 'workout_date_override',
                           'workout_skip_override', 'workout_lift_override', 'focus_day_state',
                           'macrocycle_scheduled_workout', 'import_batch']
  LOOP
    EXECUTE format('ALTER TABLE %I %s FORCE ROW LEVEL SECURITY', t, CASE WHEN forced THEN '' ELSE 'NO' END);
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION "macrocycle_set_forced_rls"(BOOLEAN) FROM PUBLIC;

SELECT "macrocycle_set_forced_rls"(false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "macrocycle" WHERE "backfilledAt" IS NOT NULL) THEN
    RAISE NOTICE 'Macrocycles were already renumbered; nothing to do';
    RETURN;
  END IF;
  PERFORM "macrocycle_backfill_window_rows"();
  PERFORM "macrocycle_close_window_rows"(NULL, false);
  PERFORM "macrocycle_renumber_by_date"(NULL, false);
END;
$$;

SELECT "macrocycle_set_forced_rls"(true);
