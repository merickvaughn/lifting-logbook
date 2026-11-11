-- Focus blocks share the lift progression vocabulary (#1213, proposal
-- docs/proposals/2026-11-10-lift-progression-types.md, "Focus blocks"): `fixed` becomes
-- `manual` and `tm` becomes `percent_wave`; `double` and `rpe` keep their names. Each block
-- plans the same sets, reps and weights under its new value.
--
-- RLS: focus_block has FORCE ROW LEVEL SECURITY (20261025000000_add_focus_work), which binds
-- the table owner too. For a role that doesn't bypass RLS, an UPDATE with app.current_user_id
-- unset matches no rows, and the new CHECK would then fail on the rows left behind. The
-- migrator is the owner, and docs/deploy.md says it bypasses RLS, but this migration doesn't
-- depend on that: FORCE is lifted for the one UPDATE, so the owner sees every row either way,
-- and restored after it. Prisma Migrate sends this file as one query string, which PostgreSQL
-- runs as one transaction, so a failure leaves FORCE on (ADR-039, Amendment 2).

ALTER TABLE "focus_block" DROP CONSTRAINT "focus_block_progression_check";

ALTER TABLE "focus_block" NO FORCE ROW LEVEL SECURITY;

UPDATE "focus_block"
SET "progression" = CASE "progression" WHEN 'fixed' THEN 'manual' WHEN 'tm' THEN 'percent_wave' END
WHERE "progression" IN ('fixed', 'tm');

ALTER TABLE "focus_block" FORCE ROW LEVEL SECURITY;

-- The list matches FOCUS_PROGRESSION_TYPES in packages/types/src/focus.ts.
ALTER TABLE "focus_block"
  ADD CONSTRAINT "focus_block_progression_check"
    CHECK ("progression" IN ('double', 'manual', 'percent_wave', 'rpe'));
