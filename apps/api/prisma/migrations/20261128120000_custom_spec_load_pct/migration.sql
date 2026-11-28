-- A program row's load percentage (#1526, part of #1141): the share of the lift's training max
-- the row plans from, as a fraction (0.85 for 85%). Null means 100%, which is every row stored
-- before this migration, so no existing program plans differently. Rolling back is dropping the
-- column: nothing else reads it.
ALTER TABLE "custom_program_spec" ADD COLUMN "loadPct" DOUBLE PRECISION;
