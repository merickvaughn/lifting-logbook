-- A set done inside a barbell complex names the complex and the round it belonged to (#1494,
-- docs/proposals/2026-11-27-barbell-complexes.md). Both are null for an ordinary set, which is
-- every row stored before this migration. Neither is part of the natural key: a complex's sets
-- of a lift take that lift's next free occurrence in the workout instead.
ALTER TABLE "lift_record" ADD COLUMN "complex" TEXT;
ALTER TABLE "lift_record" ADD COLUMN "complexRound" INTEGER;
