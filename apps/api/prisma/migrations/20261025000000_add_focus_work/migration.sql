-- Focus work (#1053, #1056): focus blocks, per-workout focus choices, and the daily focus
-- guide. See docs/adr/ADR-039-focus-block-persistence.md.

-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "focusBudgetMinutes" INTEGER,
ADD COLUMN     "focusBudgetSets" INTEGER;

-- CreateTable
CREATE TABLE "focus_block" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "align" TEXT NOT NULL,
    "start" DATE NOT NULL,
    "selection" TEXT NOT NULL,
    "overlap" TEXT NOT NULL,
    "progression" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "timer" JSONB NOT NULL,
    "onEnd" TEXT NOT NULL,
    "nextArea" TEXT,
    "pool" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "focus_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "focus_day_state" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "macrocycleNum" INTEGER NOT NULL,
    "workoutNum" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_day_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "focus_block_userId_idx" ON "focus_block"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "focus_block_userId_series_start_key" ON "focus_block"("userId", "series", "start");

-- CreateIndex
CREATE UNIQUE INDEX "focus_day_state_userId_program_macrocycleNum_workoutNum_key" ON "focus_day_state"("userId", "program", "macrocycleNum", "workoutNum");

-- CreateIndex
CREATE INDEX "lift_record_userId_lift_date_idx" ON "lift_record"("userId", "lift", "date");

-- AddConstraint: enforce the focus enums at the DB layer (mirrors body_weight_unit_check). The
-- lists match the FOCUS_* constants in packages/types/src/focus.ts.
ALTER TABLE "focus_block"
  ADD CONSTRAINT "focus_block_area_check"
    CHECK ("area" IN ('Shoulders', 'Biceps', 'Triceps', 'Back', 'Chest', 'Calves', 'Glutes', 'Core')),
  ADD CONSTRAINT "focus_block_next_area_check"
    CHECK ("nextArea" IS NULL OR "nextArea" IN ('Shoulders', 'Biceps', 'Triceps', 'Back', 'Chest', 'Calves', 'Glutes', 'Core')),
  ADD CONSTRAINT "focus_block_period_check" CHECK ("period" IN ('monthly', 'quarterly')),
  ADD CONSTRAINT "focus_block_align_check" CHECK ("align" IN ('calendar', 'custom')),
  ADD CONSTRAINT "focus_block_selection_check" CHECK ("selection" IN ('rules', 'rotate', 'fixed', 'pick')),
  ADD CONSTRAINT "focus_block_overlap_check" CHECK ("overlap" IN ('swap', 'reduce', 'skip', 'anyway')),
  ADD CONSTRAINT "focus_block_progression_check" CHECK ("progression" IN ('double', 'fixed', 'tm', 'rpe')),
  ADD CONSTRAINT "focus_block_on_end_check" CHECK ("onEnd" IN ('prompt', 'autoroll'));

-- EnableRLS
ALTER TABLE "focus_block" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "focus_block" FORCE ROW LEVEL SECURITY;
CREATE POLICY "focus_block_user_isolation" ON "focus_block"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

ALTER TABLE "focus_day_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "focus_day_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY "focus_day_state_user_isolation" ON "focus_day_state"
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));
