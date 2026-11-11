import { LiftName, LiftProgressionType, WeekNumber, WeekType } from '@lifting-logbook/types';

// RptProgramSpec interface for RPT program specification objects
export interface LiftingProgramSpec {
  week: WeekNumber;
  offset: number;
  lift: LiftName;
  increment: number;
  order: number;
  sets: number;
  reps: number;
  amrap: string | boolean;
  warmUpPct: string;
  wtDecrementPct: number;
  activation: string;
  weekType?: WeekType;
  /**
   * The row's progression override (#1210). Inside a program it wins over the lift's own
   * value (`resolveProgression`); absent means the lift's value applies.
   */
  progression?: LiftProgressionType;
  /** The bottom of the row's rep range; `reps` is the target and the top of the range. */
  repsLow?: number;
}
