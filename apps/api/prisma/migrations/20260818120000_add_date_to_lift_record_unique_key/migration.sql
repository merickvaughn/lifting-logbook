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
--
-- Deploy ordering: this migration must land before (or atomically with, via the
-- Cloud Run migration job that runs ahead of the new API revision -- see ADR-027)
-- the application code that references the renamed compound-unique accessor
-- (userId_program_cycleNum_workoutNum_date_lift_setNum). Do not roll the API
-- image back alone after this lands without also reverting the index -- the old
-- code's date-less compound-unique accessor no longer exists once this runs.
--
-- Both statements run inside Prisma's normal per-migration transaction, so
-- there is no window with only one index live; CREATE-before-DROP is kept
-- anyway as defense in depth for a manual (non-Prisma) apply, where the two
-- unique indexes coexisting briefly is harmless (the old, more restrictive
-- 6-column index continues enforcing until it's dropped). lock_timeout bounds
-- how long this can block behind an unrelated long-running statement on
-- "lift_record" -- it fails fast and retries cleanly rather than stalling the
-- table indefinitely; adjust before deploying against a large "lift_record" if
-- the index build itself needs longer than the timeout to complete.

SET LOCAL lock_timeout = '5s';

-- CreateIndex
CREATE UNIQUE INDEX "lift_record_userId_program_cycleNum_workoutNum_date_lift_se_key" ON "lift_record"("userId", "program", "cycleNum", "workoutNum", "date", "lift", "setNum");

-- DropIndex
DROP INDEX "lift_record_userId_program_cycleNum_workoutNum_lift_setNum_key";
