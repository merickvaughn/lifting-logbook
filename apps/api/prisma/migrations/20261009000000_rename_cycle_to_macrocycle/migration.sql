-- Rename "cycle" to "macrocycle" (#1038, #1039).
--
-- Rename-only: no data is rewritten. Row-level security, the policies and the grants
-- stay attached to each table through a rename; the policies are renamed only so their
-- names keep matching their tables. Index names follow Prisma's generated names for the
-- renamed columns (63-character identifiers, truncated the way Prisma truncates them).

-- macrocycle_dashboard (was cycle_dashboard)
ALTER TABLE "cycle_dashboard" RENAME TO "macrocycle_dashboard";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "cycleUnit" TO "macrocycleUnit";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "cycleNum" TO "macrocycleNum";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "cycleDate" TO "macrocycleDate";
ALTER TABLE "macrocycle_dashboard" RENAME COLUMN "cycleStartWeekday" TO "macrocycleStartWeekday";
ALTER TABLE "macrocycle_dashboard" RENAME CONSTRAINT "cycle_dashboard_pkey" TO "macrocycle_dashboard_pkey";
ALTER INDEX "cycle_dashboard_userId_program_idx" RENAME TO "macrocycle_dashboard_userId_program_idx";
ALTER INDEX "cycle_dashboard_userId_program_key" RENAME TO "macrocycle_dashboard_userId_program_key";
ALTER POLICY "cycle_dashboard_user_isolation" ON "macrocycle_dashboard" RENAME TO "macrocycle_dashboard_user_isolation";

-- macrocycle_scheduled_workout (was cycle_scheduled_workout)
ALTER TABLE "cycle_scheduled_workout" RENAME TO "macrocycle_scheduled_workout";
ALTER TABLE "macrocycle_scheduled_workout" RENAME COLUMN "cycleNum" TO "macrocycleNum";
ALTER TABLE "macrocycle_scheduled_workout" RENAME CONSTRAINT "cycle_scheduled_workout_pkey" TO "macrocycle_scheduled_workout_pkey";
ALTER INDEX "cycle_scheduled_workout_userId_program_cycleNum_idx" RENAME TO "macrocycle_scheduled_workout_userId_program_macrocycleNum_idx";
ALTER INDEX "cycle_scheduled_workout_userId_program_cycleNum_workoutNum_key" RENAME TO "macrocycle_scheduled_workout_userId_program_macrocycleNum_w_key";
ALTER POLICY "cycle_scheduled_workout_user_isolation" ON "macrocycle_scheduled_workout" RENAME TO "macrocycle_scheduled_workout_user_isolation";

-- lift_record
ALTER TABLE "lift_record" RENAME COLUMN "cycleNum" TO "macrocycleNum";
ALTER INDEX "lift_record_userId_program_cycleNum_idx" RENAME TO "lift_record_userId_program_macrocycleNum_idx";
ALTER INDEX "lift_record_userId_program_cycleNum_workoutNum_idx" RENAME TO "lift_record_userId_program_macrocycleNum_workoutNum_idx";
ALTER INDEX "lift_record_userId_program_cycleNum_workoutNum_date_lift_se_key" RENAME TO "lift_record_userId_program_macrocycleNum_workoutNum_date_li_key";

-- workout_date_override
ALTER TABLE "workout_date_override" RENAME COLUMN "cycleNum" TO "macrocycleNum";
ALTER INDEX "workout_date_override_userId_program_cycleNum_idx" RENAME TO "workout_date_override_userId_program_macrocycleNum_idx";
ALTER INDEX "workout_date_override_userId_program_cycleNum_workoutNum_key" RENAME TO "workout_date_override_userId_program_macrocycleNum_workoutN_key";

-- workout_skip_override
ALTER TABLE "workout_skip_override" RENAME COLUMN "cycleNum" TO "macrocycleNum";
ALTER INDEX "workout_skip_override_userId_program_cycleNum_idx" RENAME TO "workout_skip_override_userId_program_macrocycleNum_idx";
ALTER INDEX "workout_skip_override_userId_program_cycleNum_workoutNum_key" RENAME TO "workout_skip_override_userId_program_macrocycleNum_workoutN_key";

-- workout_lift_override
ALTER TABLE "workout_lift_override" RENAME COLUMN "cycleNum" TO "macrocycleNum";
ALTER INDEX "workout_lift_override_userId_program_cycleNum_workoutNum_idx" RENAME TO "workout_lift_override_userId_program_macrocycleNum_workoutN_idx";
ALTER INDEX "workout_lift_override_userId_program_cycleNum_workoutNum_li_key" RENAME TO "workout_lift_override_userId_program_macrocycleNum_workoutN_key";
