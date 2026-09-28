-- Bring `action` into the workout_lift_override unique key (issue #1026).
--
-- The key was one row per (userId, program, cycleNum, workoutNum, lift), so
-- replacing a lift that Manage Lifts had added overwrote its `add` row: the
-- replace then found no such lift to swap, and neither lift was planned. With
-- `action` in the key, a lift's add and its replace are separate rows.
-- `upsertOverride` still keeps one row per lift and kind: saving a lift's add
-- deletes its remove and vice versa (sameKindActions in the port). Only two racing
-- saves can leave both, and then the later write applies last.
--
-- No de-duplication step is needed: the old 5-column key already allowed only
-- one row per lift, so every existing row satisfies the new 6-column key.
--
-- Deploy ordering: this runs in the Cloud Run migration job ahead of the new API
-- revision (ADR-027). Rolling the API image back alone is safe: the old code
-- deletes every row of a lift before saving it. Reverting this index is not,
-- once a lift has both an add and a replace row; delete one of them first.

-- DropIndex
DROP INDEX "workout_lift_override_userId_program_cycleNum_workoutNum_li_key";

-- CreateIndex
CREATE UNIQUE INDEX "workout_lift_override_userId_program_cycleNum_workoutNum_li_key" ON "workout_lift_override"("userId", "program", "cycleNum", "workoutNum", "lift", "action");
