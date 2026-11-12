-- One-statement functions for the runbook's macrocycle renumbering steps (#1200, PR #1231
-- review; docs/deploy.md, "Reversing the macrocycle renumbering").
--
-- The migrator sees no rows while FORCE ROW LEVEL SECURITY is on (20261112000003), so every
-- runbook step that reads or moves numbers has to turn it off first. Done by hand, that was a
-- multi-statement transaction typed into psql: a line run on its own commits, which can leave
-- FORCE off on nine production tables, and a transaction left open holds them exclusively.
-- Each function here turns FORCE off, does its one step, and turns it back on, inside the
-- statement that calls it, so the tables are held only while it runs and FORCE can't be left
-- off: an error rolls the whole statement back.
--
-- They take each user's macrocycle lock without waiting, as the migration does. Turning FORCE
-- off waits for every transaction that has used the nine tables, so a request still holding a
-- user's lock afterwards hasn't used them; waiting on its lock would deadlock with it, and
-- skipping it is safe, since it reads the committed numbers. `macrocycle_renumber_reverse` gains
-- the same `wait_for_locks` argument for that.
--
-- This is a new migration because staging has applied 20261112000003; later changes to these
-- functions go in new migrations too.

DROP FUNCTION "macrocycle_renumber_reverse"(TEXT);

-- Puts back the numbers `macrocycle_renumber_by_date()` recorded, and moves the numbers past each
-- program's highest macrocycle to the ones after its highest recorded number. It refuses, moving
-- nothing, when a macrocycle has no "backfillNumber": the new revision created it after the
-- backfill, and there's no old number to give it. Import batches need no check, since every
-- lift-records batch's keys move with the numbers. Returns the numbers moved. Unchanged from
-- 20261112000001 but for `wait_for_locks`, passed to `macrocycle_lock_every_user`.
CREATE FUNCTION "macrocycle_renumber_reverse"(only_user TEXT DEFAULT NULL, wait_for_locks BOOLEAN DEFAULT true) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  bad_user TEXT;
  bad_program TEXT;
  bad_num INTEGER;
  users TEXT[];
  programs TEXT[];
  olds INTEGER[];
  news INTEGER[];
BEGIN
  PERFORM "macrocycle_lock_every_user"(only_user, wait_for_locks);
  SELECT "userId", "program", "macrocycleNum" INTO bad_user, bad_program, bad_num
  FROM "macrocycle" WHERE "backfillNumber" IS NULL AND (only_user IS NULL OR "userId" = only_user) LIMIT 1;
  IF bad_num IS NOT NULL THEN
    RAISE EXCEPTION 'Macrocycle % of program % for user % has no backfillNumber, so it was created after the backfill; nothing was reversed',
      bad_num, bad_program, bad_user;
  END IF;
  SELECT array_agg(r."userId"), array_agg(r."program"), array_agg(r.old_num), array_agg(r.new_num)
    INTO users, programs, olds, news
  FROM (
    SELECT "userId", "program", "macrocycleNum" AS old_num, "backfillNumber" AS new_num
    FROM "macrocycle"
    WHERE only_user IS NULL OR "userId" = only_user
    UNION ALL
    SELECT u."userId", u."program", u.num, c.top + u.pos
    FROM "macrocycle_unstarted_numbers"(only_user) AS u
    JOIN (SELECT "userId", "program", MAX("backfillNumber") AS top FROM "macrocycle"
          WHERE only_user IS NULL OR "userId" = only_user GROUP BY 1, 2) AS c
      ON c."userId" = u."userId" AND c."program" = u."program"
  ) AS r
  WHERE r.old_num <> r.new_num;
  IF olds IS NULL THEN
    RAISE NOTICE 'Every macrocycle already has its recorded number';
    RETURN 0;
  END IF;
  PERFORM "macrocycle_rewrite_numbers"(users, programs, olds, news);
  RETURN cardinality(olds);
END;
$$;

-- The runbook's reversal: every user's, or `only_user`'s. Returns the numbers moved.
CREATE FUNCTION "macrocycle_runbook_reverse"(only_user TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  moved INTEGER;
BEGIN
  PERFORM "macrocycle_set_forced_rls"(false);
  moved := "macrocycle_renumber_reverse"(only_user, false);
  PERFORM "macrocycle_set_forced_rls"(true);
  RETURN moved;
END;
$$;

-- The runbook's way forward again after a reversal: renumbers by date, keeping the recorded
-- numbers and recording one for any macrocycle created since. Returns the numbers moved.
CREATE FUNCTION "macrocycle_runbook_renumber"(only_user TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  moved INTEGER;
BEGIN
  PERFORM "macrocycle_set_forced_rls"(false);
  moved := "macrocycle_renumber_by_date"(only_user, false);
  PERFORM "macrocycle_set_forced_rls"(true);
  RETURN moved;
END;
$$;

-- What the renumbering changed, for after the deploy: the macrocycles it gave a new number, the
-- open live macrocycles no dashboard points at (should be 0), the macrocycles it recorded a number
-- for (0 means it read no rows), and the rows it closed, each with its status and end date.
CREATE FUNCTION "macrocycle_runbook_report"()
RETURNS TABLE (renumbered BIGINT, open_live_off_dashboard BIGINT, recorded BIGINT, closed JSONB)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "macrocycle_set_forced_rls"(false);
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
  PERFORM "macrocycle_set_forced_rls"(true);
END;
$$;

REVOKE EXECUTE ON FUNCTION "macrocycle_renumber_reverse"(TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_runbook_reverse"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_runbook_renumber"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_runbook_report"() FROM PUBLIC;
