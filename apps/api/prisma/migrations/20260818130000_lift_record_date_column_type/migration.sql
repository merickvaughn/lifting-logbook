-- Truncate LiftRecord.date to a calendar day (issue #884 follow-up).
--
-- The natural key / public id / SkippedRecord.naturalKey all encode `date` as a
-- compact YYYYMMDD calendar day and reconstruct it as UTC midnight when parsing
-- an id or key back into its fields (see packages/core/src/utils/jsUtil.ts's
-- parseYYYYMMDD). Until this migration, the column was a full-precision
-- `timestamp`, so any row written with a non-midnight time component (the
-- staging seed script; CSV-imported non-ISO date strings, which JS parses at
-- LOCAL midnight, not UTC midnight, on a non-UTC host) could never be matched
-- again by that reconstructed-UTC-midnight value -- PATCH-by-id and
-- delete-by-natural-key (undo) would silently find zero rows.
--
-- `@db.Date` makes the column a genuine calendar day, matching this app's own
-- domain semantics (a workout doesn't have a meaningful time-of-day) and the
-- convention already used by CycleScheduledWorkout.scheduledDate. Postgres's
-- timestamp->date cast truncates in place; Prisma always writes DateTime values
-- to a non-tz column as their UTC representation, so this truncation lands on
-- the exact same calendar day formatDateYYYYMMDD's UTC getters already derive
-- from a JS Date -- the two were only inconsistent when the *stored* value
-- carried a non-UTC-midnight time component, which this migration eliminates
-- at the source of truth.
--
-- ALTER COLUMN ... TYPE takes ACCESS EXCLUSIVE on "lift_record" for the
-- duration of the rewrite; lock_timeout bounds how long this can block behind
-- an unrelated long-running statement rather than stalling the table
-- indefinitely -- see the sibling migration
-- (20260818120000_add_date_to_lift_record_unique_key) for the same guard on
-- this table's other #884 migration.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "lift_record" ALTER COLUMN "date" SET DATA TYPE DATE;
