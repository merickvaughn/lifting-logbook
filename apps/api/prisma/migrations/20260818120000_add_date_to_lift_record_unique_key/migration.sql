-- Bring `date` into the LiftRecord natural-key unique constraint (issue #884).
--
-- Two genuinely different real workout sets can coincidentally share
-- (userId, program, cycleNum, workoutNum, lift, setNum) -- e.g. a cycle-numbering
-- reset, a multi-year gap, or historical spreadsheet drift -- and today one is
-- silently dropped by `createMany({ skipDuplicates: true })`, which treats them
-- as the same row. Adding `date` to the constraint lets the database store both.
--
-- No de-duplication step is needed: the OLD 6-column constraint already made it
-- impossible for two rows to ever share the old key, so nothing in production can
-- violate the new, strictly more specific 7-column key. This migration prevents
-- FUTURE loss only -- it cannot resurrect a row the old constraint already
-- silently dropped before this deployed.

-- DropIndex
DROP INDEX "lift_record_userId_program_cycleNum_workoutNum_lift_setNum_key";

-- CreateIndex
CREATE UNIQUE INDEX "lift_record_userId_program_cycleNum_workoutNum_date_lift_se_key" ON "lift_record"("userId", "program", "cycleNum", "workoutNum", "date", "lift", "setNum");
