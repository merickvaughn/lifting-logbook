-- Past macrocycles get a row (#1171, #1197; docs/adr/ADR-042-macrocycle-table-and-numbering.md).
--
-- Adds "macrocycle", one row per (userId, program, macrocycleNum), and gives every number
-- already stored a row. Stored numbers don't change here: renumbering by start date is
-- #1199 and #1200, in a later deploy (proposal Rollout step 1).
--
-- The backfill is a function, so the #1200 deploy can call it again for any number the old
-- API revision created between this migration and the new revision going live, and the
-- db e2e suite can run it against seeded rows. It inserts with ON CONFLICT DO NOTHING, so a
-- second call never changes a row.
--
-- One row per distinct number across the seven tables that hold one, because a macrocycle
-- can exist with no sets: starting the next one with nothing logged leaves its schedule and
-- overrides behind (proposal decision 18).
--   - The dashboard's number is `live`, `in-progress`, and starts on `macrocycleDate`, so it
--     works with zero records.
--   - Every other number is `legacy` with status `unknown`: lift_record has no origin column,
--     so nothing tells imported rows from logged ones. It starts on its first lift record,
--     else its first scheduled date, else the start of the nearest lower number, else the
--     program's earliest start, else today. It ends on its last lift record.
--
-- RLS: the INSERT runs before RLS is enabled on the new table. The migrate job connects as
-- the owner, a cloudsqlsuperuser member that RLS doesn't filter (docs/deploy.md), so it reads
-- every user's rows in the other tables. A later call needs that role too; the app role has
-- no EXECUTE on the function.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API revision
-- (ADR-027). The old revision never reads the table. A macrocycle it starts in the window
-- has no row until the new revision creates one on its next write to that number, or the
-- #1200 deploy calls the function again.
--
-- Rollback: reverting the API image alone is safe; the old code ignores the table. Dropping
-- the table loses only the rows, which this function can rebuild for anything still stored.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "macrocycle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "macrocycleNum" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "status" TEXT NOT NULL,
    "statusChosen" BOOLEAN NOT NULL DEFAULT false,
    "origin" TEXT NOT NULL,
    "unmatched" BOOLEAN NOT NULL DEFAULT false,
    "importedThrough" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "macrocycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "macrocycle_userId_program_macrocycleNum_key" ON "macrocycle"("userId", "program", "macrocycleNum");

-- CreateIndex
CREATE INDEX "macrocycle_userId_program_startDate_idx" ON "macrocycle"("userId", "program", "startDate");

-- AddConstraint: mirror MACROCYCLE_STATUSES and MACROCYCLE_ORIGINS in packages/types/src/domain.ts.
ALTER TABLE "macrocycle"
  ADD CONSTRAINT "macrocycle_status_check"
  CHECK ("status" IN ('completed', 'abandoned', 'overran', 'in-progress', 'unknown'));
ALTER TABLE "macrocycle"
  ADD CONSTRAINT "macrocycle_origin_check"
  CHECK ("origin" IN ('imported', 'live', 'legacy', 'non-cycle'));

-- Backfill
CREATE FUNCTION "macrocycle_backfill_rows"() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  inserted INTEGER;
BEGIN
  WITH nums AS (
    SELECT "userId", "program", "macrocycleNum" FROM "lift_record"
    UNION SELECT "userId", "program", "macrocycleNum" FROM "macrocycle_dashboard"
    UNION SELECT "userId", "program", "macrocycleNum" FROM "workout_date_override"
    UNION SELECT "userId", "program", "macrocycleNum" FROM "workout_skip_override"
    UNION SELECT "userId", "program", "macrocycleNum" FROM "workout_lift_override"
    UNION SELECT "userId", "program", "macrocycleNum" FROM "focus_day_state"
    UNION SELECT "userId", "program", "macrocycleNum" FROM "macrocycle_scheduled_workout"
  ),
  recs AS (
    SELECT "userId", "program", "macrocycleNum", MIN("date") AS first, MAX("date") AS last
    FROM "lift_record" GROUP BY "userId", "program", "macrocycleNum"
  ),
  sched AS (
    SELECT "userId", "program", "macrocycleNum", MIN("scheduledDate") AS first
    FROM "macrocycle_scheduled_workout" GROUP BY "userId", "program", "macrocycleNum"
  ),
  base AS (
    SELECT n."userId", n."program", n."macrocycleNum",
           d."id" IS NOT NULL AS live,
           CASE WHEN d."id" IS NOT NULL THEN d."macrocycleDate"::date
                ELSE COALESCE(r.first, s.first) END AS start,
           CASE WHEN d."id" IS NOT NULL THEN NULL ELSE r.last END AS finish
    FROM nums n
    LEFT JOIN "macrocycle_dashboard" d
      ON d."userId" = n."userId" AND d."program" = n."program" AND d."macrocycleNum" = n."macrocycleNum"
    LEFT JOIN recs r
      ON r."userId" = n."userId" AND r."program" = n."program" AND r."macrocycleNum" = n."macrocycleNum"
    LEFT JOIN sched s
      ON s."userId" = n."userId" AND s."program" = n."program" AND s."macrocycleNum" = n."macrocycleNum"
  )
  INSERT INTO "macrocycle" ("id", "userId", "program", "macrocycleNum", "startDate", "endDate", "status", "origin")
  SELECT gen_random_uuid()::text, b."userId", b."program", b."macrocycleNum",
         COALESCE(
           b.start,
           (SELECT lower_b.start FROM base lower_b
             WHERE lower_b."userId" = b."userId" AND lower_b."program" = b."program"
               AND lower_b."macrocycleNum" < b."macrocycleNum" AND lower_b.start IS NOT NULL
             ORDER BY lower_b."macrocycleNum" DESC LIMIT 1),
           (SELECT MIN(any_b.start) FROM base any_b
             WHERE any_b."userId" = b."userId" AND any_b."program" = b."program"),
           CURRENT_DATE),
         b.finish,
         CASE WHEN b.live THEN 'in-progress' ELSE 'unknown' END,
         CASE WHEN b.live THEN 'live' ELSE 'legacy' END
  FROM base b
  ON CONFLICT ("userId", "program", "macrocycleNum") DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

REVOKE EXECUTE ON FUNCTION "macrocycle_backfill_rows"() FROM PUBLIC;

SELECT "macrocycle_backfill_rows"();

-- EnableRLS
ALTER TABLE "macrocycle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "macrocycle" FORCE ROW LEVEL SECURITY;
CREATE POLICY "macrocycle_user_isolation" ON "macrocycle"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
