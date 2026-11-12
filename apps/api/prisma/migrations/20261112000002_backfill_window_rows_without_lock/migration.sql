-- `macrocycle_backfill_window_rows()` takes no lock of its own (#1200, PR #1231 review).
--
-- 20261112000001_renumber_macrocycles_by_date made it take every user's macrocycle lock. Inside
-- that migration the lock changes nothing: the opening lock and the ALTER TABLE already hold
-- them. Outside it, the function runs only in macrocycle.db.e2e.spec.ts, which calls it in a
-- transaction while other DB suites share the database, and there the lock gave their writes 409
-- `import-in-progress`. The runbook never calls it.
--
-- This is a migration of its own, not an edit to that one, because staging has already applied
-- it: `prisma migrate deploy` skips a migration it has recorded, so an edit would never reach
-- staging, and production would run SQL staging never ran. Later changes to these functions go in
-- new migrations too.

DROP FUNCTION "macrocycle_backfill_window_rows"(BOOLEAN);

-- `macrocycle_backfill_rows()`, keeping only the rows it adds on numbers no higher than the
-- program's highest macrocycle or dashboard number before the call, or that hold sets. The rows
-- past those are saved ahead of the next macrocycle, which `numbersInUse` in the API finds and
-- renumbering moves along (macrocycle-renumbering.ts, `plannedChanges`). Returns the rows kept.
-- It covers every user, as `macrocycle_backfill_rows()` does, so it takes no user id.
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
  USING "macrocycle" AS k
  LEFT JOIN unnest(users, programs, tops) AS c(u, p, top) ON c.u = k."userId" AND c.p = k."program"
  WHERE m."id" = k."id" AND m."origin" = 'legacy'
    AND m."macrocycleNum" > COALESCE(c.top, -2147483648)
    AND NOT EXISTS (
      SELECT 1 FROM "lift_record" AS r
      WHERE r."userId" = m."userId" AND r."program" = m."program" AND r."macrocycleNum" = m."macrocycleNum");
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'Added % macrocycle rows, then removed % on numbers saved ahead of the next macrocycle', inserted, removed;
  RETURN inserted - removed;
END;
$$;

REVOKE EXECUTE ON FUNCTION "macrocycle_backfill_window_rows"() FROM PUBLIC;
