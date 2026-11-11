-- Keep every existing custom program on today's rule (#1210; ADR-043).
--
-- Inside a program the spec row's progression wins. A row with none follows the lift's own
-- value, then the lifter's default, so without this a lifter who later set their default to
-- `linear` would silently change how an existing custom program progresses. Tagging every
-- row that predates the column `amrap_gated` (the rule every lift follows today) prevents
-- that. A row created after this may leave it null on purpose, to follow the lift.
--
-- Its own migration, separate from the column add, so the db e2e suite can run this file
-- against seeded rows (custom-program-progression-backfill.db.e2e.spec.ts). It touches only
-- null rows, so a second run changes nothing.
--
-- RLS: the migrate job connects as the owner, which row-level security doesn't filter
-- (docs/deploy.md), so the UPDATE reaches every user's rows.
--
-- Deploy ordering: the old API revision keeps serving until the new one is live (ADR-027).
-- A custom program it saves in that window writes null here, and so follows the lift's value
-- like a row the new editor leaves blank. The window lasts one rollout, and nothing reads the
-- column until #1211.

SET LOCAL lock_timeout = '5s';

UPDATE "custom_program_spec" SET "progression" = 'amrap_gated' WHERE "progression" IS NULL;
