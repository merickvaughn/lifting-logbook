-- Number existing macrocycles by start date (#1171, #1200; docs/adr/ADR-042-macrocycle-table-and-numbering.md).
--
-- Renumbering has run on every write since #1199, behind a setting this deploy removes. This
-- migration brings the history stored before it into the same order, in three steps:
--   1. `macrocycle_backfill_rows()` (#1197) again, for any number the old API revision created
--      after that migration ran. It skips numbers that already have a row.
--   2. `macrocycle_close_window_rows()` closes the rows that revision left open: it started the
--      next macrocycle without closing the previous one's row, so a `live`, `in-progress` row
--      remains on a number the dashboard no longer shows (PR #1204 review, finding 7).
--   3. `macrocycle_renumber_by_date()` records each row's number in "backfillNumber", then
--      numbers each user's program 1 to N by start date, ties by number, in every table that
--      holds a number and in lift-record import batches' keys.
-- `macrocycle_renumber_reverse()` puts the recorded numbers back while that's still safe; the
-- runbook (docs/deploy.md, "Reversing the macrocycle renumbering") says when.
--
-- Each function takes the macrocycle lock (`pg_advisory_xact_lock(hashtextextended(userId,
-- 1171))`, MACROCYCLE_LOCK_NAMESPACE in apps/api/src/adapters/prisma/macrocycle.repository.ts)
-- for every user before it reads, so no page write of the old revision interleaves with it. A
-- write holding the lock longer than lock_timeout fails the migration, which can be run again.
-- Each takes an optional user id that limits it to that user: the db e2e suite
-- (macrocycle.db.e2e.spec.ts) runs them that way, since other suites share its database.
--
-- RLS: the migrate job connects as the owner, which row-level security doesn't filter
-- (docs/deploy.md), so the functions reach every user's rows. The app role has no EXECUTE on any
-- of them, and a later call needs the owner too.
--
-- Deploy ordering: this runs ahead of the new API revision (ADR-027). The old revision keeps
-- serving in between with renumbering off: a page write carrying a macrocycle id resolves to the
-- new number, and one without an id is the window #1198 logged. A macrocycle the old revision
-- starts in the window takes the number past every stored one, which is already in date order.
--
-- Rollback: revert the API image, then run the reversal (docs/deploy.md). The columns can stay;
-- the old code ignores them.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "macrocycle" ADD COLUMN "backfillNumber" INTEGER;
ALTER TABLE "macrocycle" ADD COLUMN "backfilledAt" TIMESTAMP(3);

-- Takes the macrocycle lock for every user with a macrocycle (or only `only_user`), in a fixed
-- order so two callers can't deadlock each other.
CREATE FUNCTION "macrocycle_lock_every_user"(only_user TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  owner_id TEXT;
BEGIN
  FOR owner_id IN
    SELECT DISTINCT "userId" FROM "macrocycle" WHERE only_user IS NULL OR "userId" = only_user ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 1171));
  END LOOP;
END;
$$;

-- Moves each (users[i], programs[i]) number olds[i] to news[i] in every numbered table, and in
-- the keys of that user's lift-record batches for the program. Returns the rows rewritten.
--
-- The SQL form of `rewriteNumbers` (apps/api/src/adapters/prisma/macrocycle.repository.ts) and
-- `renumberPreImageKeys` (apps/api/src/programs/macrocycle-renumbering.ts): a row that doesn't
-- move but sits on a new number refuses the whole call, and moving rows go through -1 - their
-- new number, since unique keys are checked per row. A batch key's number is read with
-- PRE_IMAGE_KEY_NUMBER (apps/api/src/ports/IImportBatchRepository.ts); a `macrocycle-row:<n>`
-- key also records the number it now names.
CREATE FUNCTION "macrocycle_rewrite_numbers"(users TEXT[], programs TEXT[], olds INTEGER[], news INTEGER[]) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  tables CONSTANT TEXT[] := ARRAY[
    'lift_record', 'macrocycle_dashboard', 'workout_date_override', 'workout_skip_override',
    'workout_lift_override', 'focus_day_state', 'macrocycle_scheduled_workout', 'macrocycle'];
  tbl TEXT;
  held_user TEXT;
  held_program TEXT;
  held_num INTEGER;
  moved INTEGER;
  total INTEGER := 0;
  batches INTEGER;
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format(
      'SELECT t."userId", t."program", t."macrocycleNum" FROM %I AS t
       JOIN unnest($1::text[], $2::text[], $4::int[]) AS m(u, p, new_num)
         ON t."userId" = m.u AND t."program" = m.p AND t."macrocycleNum" = m.new_num
       WHERE NOT EXISTS (
         SELECT 1 FROM unnest($1::text[], $2::text[], $3::int[]) AS o(u, p, old_num)
         WHERE o.u = t."userId" AND o.p = t."program" AND o.old_num = t."macrocycleNum")
       LIMIT 1', tbl)
      INTO held_user, held_program, held_num
      USING users, programs, olds, news;
    IF held_num IS NOT NULL THEN
      RAISE EXCEPTION 'Macrocycle % of program % for user % in table % would merge with the one moving onto it; nothing was moved',
        held_num, held_program, held_user, tbl;
    END IF;
  END LOOP;

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE %I AS t SET "macrocycleNum" = -1 - m.new_num
       FROM unnest($1::text[], $2::text[], $3::int[], $4::int[]) AS m(u, p, old_num, new_num)
       WHERE t."userId" = m.u AND t."program" = m.p AND t."macrocycleNum" = m.old_num', tbl)
      USING users, programs, olds, news;
    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
  END LOOP;
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE %I SET "macrocycleNum" = -1 - "macrocycleNum" WHERE "macrocycleNum" < 0 AND "userId" = ANY($1::text[])', tbl)
      USING users;
  END LOOP;

  UPDATE "import_batch" AS b SET "preImage" = (
    SELECT jsonb_object_agg(
      CASE WHEN m.new_num IS NULL THEN e.key
           WHEN e.key LIKE 'macrocycle-row:%' THEN 'macrocycle-row:' || m.new_num::text
           ELSE m.new_num::text || COALESCE(substring(e.key from '^[0-9]+(:.*)$'), '') END,
      CASE WHEN m.new_num IS NOT NULL AND e.key LIKE 'macrocycle-row:%'
           THEN e.value || jsonb_build_object('wrote', jsonb_build_object('macrocycleNum', m.new_num))
           ELSE e.value END)
    FROM jsonb_each(b."preImage") AS e
    LEFT JOIN unnest(users, programs, olds, news) AS m(u, p, old_num, new_num)
      ON m.u = b."userId" AND m.p = b."program"
     AND m.old_num::numeric = substring(e.key from '^(?:macrocycle-row:)?([0-9]+)(?::|$)')::numeric
  )
  WHERE b."destination" = 'lift-records' AND b."userId" = ANY(users)
    AND EXISTS (
      SELECT 1 FROM jsonb_object_keys(b."preImage") AS k
      JOIN unnest(users, programs, olds) AS m(u, p, old_num)
        ON m.u = b."userId" AND m.p = b."program"
       AND m.old_num::numeric = substring(k from '^(?:macrocycle-row:)?([0-9]+)(?::|$)')::numeric);
  GET DIAGNOSTICS batches = ROW_COUNT;

  RAISE NOTICE 'Moved % macrocycle numbers: % rows, % import batches', cardinality(olds), total, batches;
  RETURN total;
END;
$$;

-- Closes each `live`, `in-progress` row with no end date on a number its program's dashboard
-- doesn't show. Like starting the next macrocycle (macrocycle-generation.service.ts), it ends on
-- the number's last set, or its start with none, and a status the lifter chose stays. Otherwise
-- `closingStatus` decides, with the program's workout count read from the number's scheduled
-- workouts, since SQL can't expand a program spec: `completed` when every scheduled workout has
-- a set, `abandoned` when one doesn't, and `unknown` with no schedule. Returns the rows closed.
CREATE FUNCTION "macrocycle_close_window_rows"(only_user TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  closed INTEGER;
BEGIN
  PERFORM "macrocycle_lock_every_user"(only_user);
  WITH closing AS (
    SELECT m."id", sets.last, sched.planned,
           (SELECT COUNT(DISTINCT r."workoutNum") FROM "lift_record" AS r
             WHERE r."userId" = m."userId" AND r."program" = m."program" AND r."macrocycleNum" = m."macrocycleNum"
               AND r."workoutNum" BETWEEN 1 AND sched.planned) AS done
    FROM "macrocycle" AS m
    CROSS JOIN LATERAL (
      SELECT MAX(r."date") AS last FROM "lift_record" AS r
      WHERE r."userId" = m."userId" AND r."program" = m."program" AND r."macrocycleNum" = m."macrocycleNum") AS sets
    CROSS JOIN LATERAL (
      SELECT COUNT(DISTINCT s."workoutNum") AS planned FROM "macrocycle_scheduled_workout" AS s
      WHERE s."userId" = m."userId" AND s."program" = m."program" AND s."macrocycleNum" = m."macrocycleNum") AS sched
    WHERE (only_user IS NULL OR m."userId" = only_user)
      AND m."origin" = 'live' AND m."status" = 'in-progress' AND m."endDate" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "macrocycle_dashboard" AS d
        WHERE d."userId" = m."userId" AND d."program" = m."program" AND d."macrocycleNum" = m."macrocycleNum")
  )
  UPDATE "macrocycle" AS m
  SET "endDate" = COALESCE(c.last, m."startDate"),
      "status" = CASE WHEN m."statusChosen" THEN m."status"
                      WHEN c.planned = 0 THEN 'unknown'
                      WHEN c.done >= c.planned THEN 'completed'
                      ELSE 'abandoned' END
  FROM closing AS c
  WHERE m."id" = c."id";
  GET DIAGNOSTICS closed = ROW_COUNT;
  RAISE NOTICE 'Closed % macrocycle rows left open', closed;
  RETURN closed;
END;
$$;

-- Records each row's number in "backfillNumber" (once: a later call keeps the first), then
-- numbers each user's program 1 to N by start date, ties by number. Returns the numbers moved.
CREATE FUNCTION "macrocycle_renumber_by_date"(only_user TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  users TEXT[];
  programs TEXT[];
  olds INTEGER[];
  news INTEGER[];
BEGIN
  PERFORM "macrocycle_lock_every_user"(only_user);
  -- UTC, as Prisma stores "import_batch"."createdAt", which the reversal compares it with.
  UPDATE "macrocycle" SET "backfillNumber" = "macrocycleNum", "backfilledAt" = timezone('UTC', now())
  WHERE "backfillNumber" IS NULL AND (only_user IS NULL OR "userId" = only_user);
  SELECT array_agg(r."userId"), array_agg(r."program"), array_agg(r."macrocycleNum"), array_agg(r.new_num)
    INTO users, programs, olds, news
  FROM (
    SELECT "userId", "program", "macrocycleNum",
           ROW_NUMBER() OVER (PARTITION BY "userId", "program" ORDER BY "startDate", "macrocycleNum")::int AS new_num
    FROM "macrocycle"
    WHERE only_user IS NULL OR "userId" = only_user
  ) AS r
  WHERE r."macrocycleNum" <> r.new_num;
  IF olds IS NULL THEN
    RAISE NOTICE 'Every macrocycle is already numbered by start date';
    RETURN 0;
  END IF;
  PERFORM "macrocycle_rewrite_numbers"(users, programs, olds, news);
  RETURN cardinality(olds);
END;
$$;

-- Puts back the numbers `macrocycle_renumber_by_date()` recorded. It refuses, moving nothing,
-- once that's no longer safe:
--   - a macrocycle has no "backfillNumber": the new revision created it after the backfill, and
--     its number means nothing to the old code;
--   - an import batch is newer than its program's backfill: its keys were written for the new
--     numbers, and the old code's undo would read them as old ones.
-- Returns the numbers moved.
CREATE FUNCTION "macrocycle_renumber_reverse"(only_user TEXT DEFAULT NULL) RETURNS INTEGER
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
  PERFORM "macrocycle_lock_every_user"(only_user);
  SELECT "userId", "program", "macrocycleNum" INTO bad_user, bad_program, bad_num
  FROM "macrocycle" WHERE "backfillNumber" IS NULL AND (only_user IS NULL OR "userId" = only_user) LIMIT 1;
  IF bad_num IS NOT NULL THEN
    RAISE EXCEPTION 'Macrocycle % of program % for user % has no backfillNumber, so it was created after the backfill; nothing was reversed',
      bad_num, bad_program, bad_user;
  END IF;
  SELECT b."userId", b."program" INTO bad_user, bad_program
  FROM "import_batch" AS b
  WHERE (only_user IS NULL OR b."userId" = only_user)
    AND b."createdAt" > (
      SELECT MIN(m."backfilledAt") FROM "macrocycle" AS m WHERE m."userId" = b."userId" AND m."program" = b."program")
  LIMIT 1;
  IF bad_user IS NOT NULL THEN
    RAISE EXCEPTION 'Program % for user % has an import newer than the backfill; nothing was reversed', bad_program, bad_user;
  END IF;
  SELECT array_agg("userId"), array_agg("program"), array_agg("macrocycleNum"), array_agg("backfillNumber")
    INTO users, programs, olds, news
  FROM "macrocycle"
  WHERE "macrocycleNum" <> "backfillNumber" AND (only_user IS NULL OR "userId" = only_user);
  IF olds IS NULL THEN
    RAISE NOTICE 'Every macrocycle already has its recorded number';
    RETURN 0;
  END IF;
  PERFORM "macrocycle_rewrite_numbers"(users, programs, olds, news);
  RETURN cardinality(olds);
END;
$$;

REVOKE EXECUTE ON FUNCTION "macrocycle_lock_every_user"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_rewrite_numbers"(TEXT[], TEXT[], INTEGER[], INTEGER[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_close_window_rows"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_renumber_by_date"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_renumber_reverse"(TEXT) FROM PUBLIC;

SELECT "macrocycle_backfill_rows"();
SELECT "macrocycle_close_window_rows"();
SELECT "macrocycle_renumber_by_date"();
