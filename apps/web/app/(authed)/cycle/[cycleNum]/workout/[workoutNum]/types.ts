import type { LiftRecordResponse, WeightUnit } from '@lifting-logbook/types';

export interface WarmUpSetData {
  /** Number of reps for this warm-up set. */
  reps: number;
  /**
   * Total planned load in lbs (TM × pct, MROUND'd).
   * For bodyweight-component lifts this is the total load —
   * the UI derives added weight after the bodyweight gate.
   */
  totalLoad: number;
}

/**
 * What the logger needs from an already-logged set: the id to PATCH, and the
 * three values it displays and pre-fills. Sourced from `SetResponse` on the
 * workout itself (issue #978), so the page no longer fetches the whole cycle's
 * lift records to recover them; a freshly logged `LiftRecordResponse` is a
 * structural superset and flows into the same slot.
 */
export type LoggedSet = Pick<LiftRecordResponse, 'id' | 'weight' | 'reps' | 'notes'>;

export interface WorkingSetData {
  setNum: number;
  /** Total planned load (barbell: bar weight; BW-component: targetLoad). */
  totalLoad: number;
  reps: number;
  amrap: boolean;
  /** Pre-populated when a logged record already exists for this set. */
  existing?: LoggedSet;
}

export interface LiftData {
  lift: string;
  isBodyweightComponent: boolean;
  /**
   * For bodyweight-component lifts, the warm-up implement name shown
   * above the warm-up set list (e.g. "lat pulldown", "dips").
   */
  warmUpImplement?: string;
  warmUpSets: WarmUpSetData[];
  workingSets: WorkingSetData[];
}

export interface WorkoutLoggerProps {
  program: string;
  cycleNum: number;
  workoutNum: number;
  /** ISO date string for this workout (used when creating lift records). */
  date: string;
  lifts: LiftData[];
  hasBodyweightComponent: boolean;
  isReadOnly: boolean;
  /**
   * Body weight in lbs already recorded for this workout's date, if any.
   * page.tsx normalizes from the stored per-record unit so this is always lbs —
   * every added-load calculation subtracts it from an lbs plan load.
   * When set, the bodyweight gate is skipped and this value is used directly.
   * When null, the gate fires on first render (unless isReadOnly or !hasBodyweightComponent).
   */
  initialBodyWeight: number | null;
  /**
   * Global weight-unit display preference. Planned and logged weights are
   * rendered in this unit; the working-set weight input and everything submitted
   * stay in lbs (lift records have no per-record unit), while body weight is
   * entered and persisted in this unit. Display preference only — see
   * docs/standards/training-max-precision.md.
   */
  unit: WeightUnit;
}
