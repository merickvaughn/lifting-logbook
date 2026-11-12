-- `macrocycle_backfill_window_rows()` keeps a row for a number with no sets below a number with
-- sets (#1200, PR #1231 review).
--
-- 20261112000002_backfill_window_rows_without_lock removed every row it added past the program's
-- highest macrocycle or dashboard number that held no sets. A number with sets above that one
-- kept its row, so a no-set number between them, such as a focus state on 3 with the dashboard on
-- 2 and sets on 4, lost its row. Then it was neither a macrocycle nor past the highest one, and
-- `macrocycle_renumber_by_date()` moved a macrocycle onto it and raised *would merge*, failing
-- 20261112000003 on every try. Now the cut-off also counts the numbers with sets, so the rows
-- removed are only those past every macrocycle, dashboard and set: rows saved ahead of the next
-- macrocycle, which renumbering moves past the last one.
--
-- The name sorts after 20261112000002_backfill_window_rows_without_lock and before
-- 20261112000003, so a database that hasn't run 20261112000003 (production) runs this first.
-- Staging had already run 20261112000003 to 20261112000006, so `prisma migrate deploy` runs this
-- there after them, where it only replaces the function: nothing calls it after 20261112000003.

CREATE OR REPLACE FUNCTION "macrocycle_backfill_window_rows"() RETURNS INTEGER
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
      UNION ALL SELECT "userId", "program", "macrocycleNum" FROM "lift_record"
    ) AS numbered
    GROUP BY 1, 2
  ) AS c;
  inserted := "macrocycle_backfill_rows"();
  DELETE FROM "macrocycle" AS m
  USING "macrocycle" AS k
  LEFT JOIN unnest(users, programs, tops) AS c(u, p, top) ON c.u = k."userId" AND c.p = k."program"
  WHERE m."id" = k."id" AND m."origin" = 'legacy'
    AND m."macrocycleNum" > COALESCE(c.top, -2147483648);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'Added % macrocycle rows, then removed % on numbers saved ahead of the next macrocycle', inserted, removed;
  RETURN inserted - removed;
END;
$$;

COMMENT ON FUNCTION "macrocycle_backfill_window_rows"() IS
  'macrocycle_backfill_rows(), then removes the legacy rows it added past each program''s highest macrocycle, dashboard and set number: rows saved ahead of the next macrocycle (#1200).';

REVOKE EXECUTE ON FUNCTION "macrocycle_backfill_window_rows"() FROM PUBLIC;
