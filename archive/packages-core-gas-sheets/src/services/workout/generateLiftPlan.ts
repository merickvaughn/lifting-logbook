import {
  LIFT_DATE_HEADER,
  PROG_SPEC_WARMUP_PCTS,
  PROG_SPEC_WORK_PCTS,
  WARMUP_BASE_REPS,
} from "@src/core/constants";
import { LiftingProgramSpec, SpreadsheetCell, TrainingMax } from "@src/core/models";

// Test-week: 5-set ascending ramp-up ending in a heavy single (50/65/80/90/100%)
const TEST_WEEK_PCTS = [0.50, 0.65, 0.80, 0.90, 1.00];
const TEST_WEEK_REPS = [5,    3,    2,    1,    1   ];

// Deload week: 3 light sets at 40/50/60%
const DELOAD_PCTS = [0.40, 0.50, 0.60];
const DELOAD_REPS = [5,    5,    5   ];

export function generateLiftPlan(
  _tm: TrainingMax,
  ps: LiftingProgramSpec,
  _startDate: Date,
): SpreadsheetCell[][] {
  const workoutGrid: SpreadsheetCell[][] = [];
  const liftName = ps.lift;
  const increment = ps.increment;

  const dateFormula = `=INDEX(A1:F, MATCH("${liftName}", A1:A, 0), MATCH("${LIFT_DATE_HEADER}", A2:2, 0))`;
  const weightFormula = (pct: number) =>
    `=MROUND(PRODUCT(INDEX(A1:D, MATCH("${liftName}", A1:A, 0), MATCH("TM", A2:2, 0)), ${pct}), ${increment})`;

  if (ps.weekType === 'test') {
    for (let k = 0; k < TEST_WEEK_PCTS.length; k++) {
      workoutGrid.push([dateFormula, liftName, `Set ${k + 1}`, weightFormula(TEST_WEEK_PCTS[k]!), TEST_WEEK_REPS[k]!, ""]);
    }
    return workoutGrid;
  }

  if (ps.weekType === 'deload') {
    for (let k = 0; k < DELOAD_PCTS.length; k++) {
      workoutGrid.push([dateFormula, liftName, `Set ${k + 1}`, weightFormula(DELOAD_PCTS[k]!), DELOAD_REPS[k]!, ""]);
    }
    return workoutGrid;
  }

  // training week (default)
  const progSpecWarmPcts = PROG_SPEC_WARMUP_PCTS(ps.warmUpPct);
  const progSpecWorkPcts = PROG_SPEC_WORK_PCTS(ps.sets, ps.wtDecrementPct);

  for (let k = 0; k < progSpecWarmPcts.length; k++) {
    workoutGrid.push([
      dateFormula,
      liftName,
      `Warm-up ${k + 1}`,
      weightFormula(progSpecWarmPcts[k]!),
      WARMUP_BASE_REPS - k,
      "",
    ]);
  }
  for (let k = 0; k < progSpecWorkPcts.length; k++) {
    workoutGrid.push([
      dateFormula,
      liftName,
      `Set ${k + 1}`,
      weightFormula(progSpecWorkPcts[k]!),
      "",
      "",
    ]);
  }
  return workoutGrid;
}
