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
  /**
   * The raw `Weight %` list (`1,.95,.9`) of a spec that has that column instead of
   * `WT Decrement %`. Kept so the validator can name the field when the list's steps
   * aren't even and `wtDecrementPct` is therefore NaN.
   */
  weightPct?: string;
  activation: string;
  weekType?: WeekType;
  /**
   * The row's progression override (#1210). Inside a program it wins over the lift's own
   * value (`resolveProgression`); absent means the lift's value applies.
   */
  progression?: LiftProgressionType;
  /** The bottom of the row's rep range; `reps` is the target and the top of the range. */
  repsLow?: number;
  /**
   * Ids of the lift modifications this slot starts with on (#1155). Absent means none. They
   * belong to the slot's lift, so a Manage Lifts `replace` doesn't carry them over.
   */
  modifications?: string[];
}
