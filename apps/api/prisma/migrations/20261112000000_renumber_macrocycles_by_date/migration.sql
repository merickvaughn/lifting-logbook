-- Number existing macrocycles by start date (#1171, #1200; docs/adr/ADR-042-macrocycle-table-and-numbering.md).
--
-- Renumbering has run on every write since #1199, behind a setting this deploy removes. This
-- migration brings the history stored before it into the same order, in three steps:
--   1. `macrocycle_backfill_window_rows()` runs `macrocycle_backfill_rows()` (#1197) again, for
--      any number the old API revision created after that migration ran, which skips numbers
--      that already have a row. It then removes the rows that call made for numbers past every
--      macrocycle that hold no sets: rows saved before the next macrocycle starts, such as a focus
--      state saved before initializing, which belong to that macrocycle rather than forming one.
--   2. `macrocycle_close_window_rows()` closes the rows that revision left open: it started the
--      next macrocycle without closing the previous one's row, so a `live`, `in-progress` row
--      remains on a number the dashboard no longer shows (PR #1204 review, finding 7).
--   3. `macrocycle_renumber_by_date()` records each row's number in "backfillNumber", then
--      numbers each user's program 1 to N by start date, ties by number, in every table that
--      holds a number and in lift-record import batches' keys. Rows on numbers past every
--      macrocycle move to the numbers after N, as the API moves them.
-- `macrocycle_renumber_reverse()` puts the recorded numbers back; the runbook (docs/deploy.md,
-- "Reversing the macrocycle renumbering") says when that's needed.
--
-- Locks. The migration takes the macrocycle lock (`pg_advisory_xact_lock(hashtextextended(userId,
-- 1171))`, MACROCYCLE_LOCK_NAMESPACE in apps/api/src/adapters/prisma/macrocycle.repository.ts)
-- for every user before anything else, the ALTER TABLE included. The old revision takes that lock
-- first and reads "macrocycle" second, so taking them in the same order means neither can wait on
-- the other in a cycle. Once it holds a user's lock, that user's page reads carry no id and their
-- writes get 409 `import-in-progress`; the ALTER TABLE then holds "macrocycle" until the migration
-- commits, so every read of it waits that long. The whole run is one statement per table per
-- step, about a second for 20,000 rows on local Postgres (ADR-042).
-- An import holds a user's lock for up to its 30-second transaction, so lock_timeout allows 40
-- seconds. If it still runs out, the migration fails and Prisma records it as failed, which stops
-- every later deploy until someone runs `prisma migrate resolve --rolled-back` (docs/deploy.md,
-- "If the renumbering migration fails").
--
-- The functions take an optional user id that limits them to that user: the db e2e suite
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
-- Rollback: revert the API image. The #1199 revision checks ids, so it runs on the new numbers;
-- the reversal is for rolling back further (docs/deploy.md). The columns can stay; the old code
-- ignores them.

SET LOCAL lock_timeout = '40s';

-- Takes the macrocycle lock for every user with a numbered row in any of the eight tables (or
-- only `only_user`), in a fixed order so two callers can't deadlock each other.
CREATE FUNCTION "macrocycle_lock_every_user"(only_user TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  owner_id TEXT;
BEGIN
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
    PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 1171));
  END LOOP;
END;
$$;

SELECT "macrocycle_lock_every_user"(NULL);

-- AlterTable
ALTER TABLE "macrocycle" ADD COLUMN "backfillNumber" INTEGER;
ALTER TABLE "macrocycle" ADD COLUMN "backfilledAt" TIMESTAMP(3);

-- Moves each (users[i], programs[i]) number olds[i] to news[i] in every numbered table, and in
-- the keys of that user's lift-record batches for the program. Returns the rows rewritten.
--
-- The SQL form of `rewriteNumbers` (apps/api/src/adapters/prisma/macrocycle.repository.ts) and
-- `renumberPreImageKeys` (apps/api/src/programs/macrocycle-renumbering.ts): a row that doesn't
-- move but sits on a new number refuses the whole call. Since unique keys are checked per row,
-- moving rows are parked first, on -2 * bound - their new number, where bound is past every
-- number the call reads or writes. Stored history can hold negative numbers (a file's number was
-- stored as is before #1224 checked its range), and parking there can't land on one. Only the
-- parked rows are moved back out, per program.
-- A batch key's number is read as PRE_IMAGE_KEY_NUMBER (apps/api/src/ports/IImportBatchRepository.ts)
-- reads it, with a sign allowed for the same reason; a `macrocycle-row:<n>` key also records the
-- number it now names.
CREATE FUNCTION "macrocycle_rewrite_numbers"(users TEXT[], programs TEXT[], olds INTEGER[], news INTEGER[]) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  tables CONSTANT TEXT[] := ARRAY[
    'lift_record', 'macrocycle_dashboard', 'workout_date_override', 'workout_skip_override',
    'workout_lift_override', 'focus_day_state', 'macrocycle_scheduled_workout', 'macrocycle'];
  key_number CONSTANT TEXT := '^(?:macrocycle-row:)?(-?[0-9]+)(?::|$)';
  tbl TEXT;
  held_user TEXT;
  held_program TEXT;
  held_num INTEGER;
  widest INTEGER;
  bound INTEGER;
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

  SELECT MAX(abs(n)) INTO bound FROM unnest(olds || news) AS n;
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('SELECT MAX(abs("macrocycleNum")) FROM %I WHERE "userId" = ANY($1::text[])', tbl)
      INTO widest USING users;
    bound := GREATEST(bound, widest);
  END LOOP;
  IF bound > 700000000 THEN
    RAISE EXCEPTION 'A stored macrocycle number reaches %, too large to move through parked numbers; nothing was moved', bound;
  END IF;
  bound := bound + 1;

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE %I AS t SET "macrocycleNum" = -2 * $5 - m.new_num
       FROM unnest($1::text[], $2::text[], $3::int[], $4::int[]) AS m(u, p, old_num, new_num)
       WHERE t."userId" = m.u AND t."program" = m.p AND t."macrocycleNum" = m.old_num', tbl)
      USING users, programs, olds, news, bound;
    GET DIAGNOSTICS moved = ROW_COUNT;
    total := total + moved;
  END LOOP;
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE %I AS t SET "macrocycleNum" = m.new_num
       FROM unnest($1::text[], $2::text[], $3::int[]) AS m(u, p, new_num)
       WHERE t."userId" = m.u AND t."program" = m.p AND t."macrocycleNum" = -2 * $4 - m.new_num', tbl)
      USING users, programs, news, bound;
  END LOOP;

  UPDATE "import_batch" AS b SET "preImage" = (
    SELECT jsonb_object_agg(
      CASE WHEN m.new_num IS NULL THEN e.key
           WHEN e.key LIKE 'macrocycle-row:%' THEN 'macrocycle-row:' || m.new_num::text
           ELSE m.new_num::text || COALESCE(substring(e.key from '^-?[0-9]+(:.*)$'), '') END,
      CASE WHEN m.new_num IS NOT NULL AND e.key LIKE 'macrocycle-row:%'
           THEN e.value || jsonb_build_object('wrote', jsonb_build_object('macrocycleNum', m.new_num))
           ELSE e.value END)
    FROM jsonb_each(b."preImage") AS e
    LEFT JOIN unnest(users, programs, olds, news) AS m(u, p, old_num, new_num)
      ON m.u = b."userId" AND m.p = b."program"
     AND m.old_num::numeric = substring(e.key from key_number)::numeric
  )
  WHERE b."destination" = 'lift-records' AND b."userId" = ANY(users)
    AND EXISTS (
      SELECT 1 FROM jsonb_object_keys(b."preImage") AS k
      JOIN unnest(users, programs, olds) AS m(u, p, old_num)
        ON m.u = b."userId" AND m.p = b."program"
       AND m.old_num::numeric = substring(k from key_number)::numeric);
  GET DIAGNOSTICS batches = ROW_COUNT;

  RAISE NOTICE 'Moved % macrocycle numbers: % rows, % import batches', cardinality(olds), total, batches;
  RETURN total;
END;
$$;

-- `macrocycle_backfill_rows()`, keeping only the rows it adds on numbers no higher than the
-- program's highest macrocycle or dashboard number before the call, or that hold sets. The rows
-- past those are saved ahead of the next macrocycle, which `numbersInUse` in the API finds and
-- renumbering moves along (macrocycle-renumbering.ts, `plannedChanges`). Returns the rows kept.
CREATE FUNCTION "macrocycle_backfill_window_rows"() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  users TEXT[];
  programs TEXT[];
  tops INTEGER[];
  inserted INTEGER;
  removed INTEGER;
BEGIN
  SELECT array_agg(c."userId"), array_agg(c."program"), array_agg(c.top) INTO users, programs, tops
  FROM (
    SELECT "userId", "program", MAX("macrocycleNum") AS top FROM (
      SELECT "userId", "program", "macrocycleNum" FROM "macrocycle"
      UNION ALL SELECT "userId", "program", "macrocycleNum" FROM "macrocycle_dashboard"
    ) AS numbered
    GROUP BY 1, 2
  ) AS c;
  inserted := "macrocycle_backfill_rows"();
  DELETE FROM "macrocycle" AS m
  WHERE m."origin" = 'legacy'
    AND m."macrocycleNum" > COALESCE(
      (SELECT c.top FROM unnest(users, programs, tops) AS c(u, p, top) WHERE c.u = m."userId" AND c.p = m."program"),
      -2147483648)
    AND NOT EXISTS (
      SELECT 1 FROM "lift_record" AS r
      WHERE r."userId" = m."userId" AND r."program" = m."program" AND r."macrocycleNum" = m."macrocycleNum");
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'Added % macrocycle rows, then removed % on numbers saved ahead of the next macrocycle', inserted, removed;
  RETURN inserted - removed;
END;
$$;

-- Each program's numbers past its highest macrocycle that rows in the other seven tables hold,
-- with their position in number order: rows saved before the next macrocycle starts. The SQL form
-- of `numbersInUse(program, highest)`.
CREATE FUNCTION "macrocycle_unstarted_numbers"(only_user TEXT)
RETURNS TABLE ("userId" TEXT, "program" TEXT, num INTEGER, pos INTEGER)
LANGUAGE sql AS $$
  WITH top AS (
    SELECT m."userId", m."program", MAX(m."macrocycleNum") AS top FROM "macrocycle" AS m
    WHERE only_user IS NULL OR m."userId" = only_user GROUP BY 1, 2
  ),
  held AS (
    SELECT t."userId", t."program", t."macrocycleNum" FROM "lift_record" AS t
    UNION SELECT t."userId", t."program", t."macrocycleNum" FROM "macrocycle_dashboard" AS t
    UNION SELECT t."userId", t."program", t."macrocycleNum" FROM "workout_date_override" AS t
    UNION SELECT t."userId", t."program", t."macrocycleNum" FROM "workout_skip_override" AS t
    UNION SELECT t."userId", t."program", t."macrocycleNum" FROM "workout_lift_override" AS t
    UNION SELECT t."userId", t."program", t."macrocycleNum" FROM "focus_day_state" AS t
    UNION SELECT t."userId", t."program", t."macrocycleNum" FROM "macrocycle_scheduled_workout" AS t
  )
  SELECT h."userId", h."program", h."macrocycleNum",
         ROW_NUMBER() OVER (PARTITION BY h."userId", h."program" ORDER BY h."macrocycleNum")::int
  FROM held AS h JOIN top AS t ON t."userId" = h."userId" AND t."program" = h."program"
  WHERE h."macrocycleNum" > t.top;
$$;

-- Closes each `live`, `in-progress` row with no end date on a number its program's dashboard
-- doesn't show. Like starting the next macrocycle (macrocycle-generation.service.ts), it ends on
-- the number's last set, or its start with none, and a status the lifter chose stays. Otherwise
-- `closingStatus` decides, with the program's workouts read from the number's scheduled workouts,
-- since SQL can't expand a program spec: `completed` when every scheduled workout has a set,
-- `abandoned` when one doesn't, and `unknown` with no schedule. Returns the rows closed.
CREATE FUNCTION "macrocycle_close_window_rows"(only_user TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  closed INTEGER;
BEGIN
  PERFORM "macrocycle_lock_every_user"(only_user);
  WITH closing AS (
    SELECT m."id", sets.last, sched.planned,
           (SELECT COUNT(DISTINCT s."workoutNum") FROM "macrocycle_scheduled_workout" AS s
             WHERE s."userId" = m."userId" AND s."program" = m."program" AND s."macrocycleNum" = m."macrocycleNum"
               AND EXISTS (
                 SELECT 1 FROM "lift_record" AS r
                 WHERE r."userId" = s."userId" AND r."program" = s."program"
                   AND r."macrocycleNum" = s."macrocycleNum" AND r."workoutNum" = s."workoutNum")) AS done
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
-- numbers each user's program 1 to N by start date, ties by number, and moves the numbers past
-- its highest macrocycle to N + 1 onward. Returns the numbers moved.
CREATE FUNCTION "macrocycle_renumber_by_date"(only_user TEXT DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  users TEXT[];
  programs TEXT[];
  olds INTEGER[];
  news INTEGER[];
BEGIN
  PERFORM "macrocycle_lock_every_user"(only_user);
  UPDATE "macrocycle" SET "backfillNumber" = "macrocycleNum", "backfilledAt" = timezone('UTC', now())
  WHERE "backfillNumber" IS NULL AND (only_user IS NULL OR "userId" = only_user);
  SELECT array_agg(r."userId"), array_agg(r."program"), array_agg(r.old_num), array_agg(r.new_num)
    INTO users, programs, olds, news
  FROM (
    SELECT "userId", "program", "macrocycleNum" AS old_num,
           ROW_NUMBER() OVER (PARTITION BY "userId", "program" ORDER BY "startDate", "macrocycleNum")::int AS new_num
    FROM "macrocycle"
    WHERE only_user IS NULL OR "userId" = only_user
    UNION ALL
    SELECT u."userId", u."program", u.num, c.n + u.pos
    FROM "macrocycle_unstarted_numbers"(only_user) AS u
    JOIN (SELECT "userId", "program", COUNT(*)::int AS n FROM "macrocycle" GROUP BY 1, 2) AS c
      ON c."userId" = u."userId" AND c."program" = u."program"
  ) AS r
  WHERE r.old_num <> r.new_num;
  IF olds IS NULL THEN
    RAISE NOTICE 'Every macrocycle is already numbered by start date';
    RETURN 0;
  END IF;
  PERFORM "macrocycle_rewrite_numbers"(users, programs, olds, news);
  RETURN cardinality(olds);
END;
$$;

-- Puts back the numbers `macrocycle_renumber_by_date()` recorded, and moves the numbers past each
-- program's highest macrocycle to the ones after its highest recorded number. It refuses, moving
-- nothing, when a macrocycle has no "backfillNumber": the new revision created it after the
-- backfill, and there's no old number to give it. Import batches need no check, since every
-- lift-records batch's keys move with the numbers. Returns the numbers moved.
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
  SELECT array_agg(r."userId"), array_agg(r."program"), array_agg(r.old_num), array_agg(r.new_num)
    INTO users, programs, olds, news
  FROM (
    SELECT "userId", "program", "macrocycleNum" AS old_num, "backfillNumber" AS new_num
    FROM "macrocycle"
    WHERE only_user IS NULL OR "userId" = only_user
    UNION ALL
    SELECT u."userId", u."program", u.num, c.top + u.pos
    FROM "macrocycle_unstarted_numbers"(only_user) AS u
    JOIN (SELECT "userId", "program", MAX("backfillNumber") AS top FROM "macrocycle" GROUP BY 1, 2) AS c
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

REVOKE EXECUTE ON FUNCTION "macrocycle_lock_every_user"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_rewrite_numbers"(TEXT[], TEXT[], INTEGER[], INTEGER[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_backfill_window_rows"() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_unstarted_numbers"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_close_window_rows"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_renumber_by_date"(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "macrocycle_renumber_reverse"(TEXT) FROM PUBLIC;

SELECT "macrocycle_backfill_window_rows"();
SELECT "macrocycle_close_window_rows"();
SELECT "macrocycle_renumber_by_date"();
