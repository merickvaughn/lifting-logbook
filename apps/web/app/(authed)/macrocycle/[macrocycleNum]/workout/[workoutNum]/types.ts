import type { LiftingProgramSpecResponse, LiftRecordResponse, WeightUnit } from '@lifting-logbook/types';

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
 * values it displays and pre-fills, with the modifications that were on (#1152). Sourced from `SetResponse` on the
 * workout itself (issue #978), so the page no longer fetches the whole macrocycle's
 * lift records to recover them; a freshly logged `LiftRecordResponse` is a
 * structural superset and flows into the same slot.
 */
export type LoggedSet = Pick<LiftRecordResponse, 'id' | 'weight' | 'reps' | 'notes' | 'modifications'>;

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
  /**
   * Which occurrence of `lift` in the workout, from 0 (`WorkoutLiftResponse.occurrence`);
   * absent means 0. A program can plan one lift twice in a day, and each occurrence logs
   * its own sets, so the logger keys a set by occurrence as well as lift (#1027).
   */
  occurrence?: number;
  isBodyweightComponent: boolean;
  /**
   * For bodyweight-component lifts, the warm-up implement name shown
   * above the warm-up set list (e.g. "lat pulldown", "dips").
   */
  warmUpImplement?: string;
  warmUpSets: WarmUpSetData[];
  workingSets: WorkingSetData[];
  /**
   * Set on a focus lift (#1060): its focus block's area and the prescription summary,
   * e.g. "3 × 10–12". Absent on a planned lift.
   */
  focus?: { area: string; summary: string };
  /**
   * The lift's spec row and its own max, so turning on an `own` modification can re-plan it
   * without a fetch (#1153). Absent where nothing plans the lift: a focus lift, or one with no spec
   * row, which toggles label but don't re-plan.
   */
  plan?: { spec: LiftingProgramSpecResponse; liftMax: number };
}

export interface WorkoutLoggerProps {
  program: string;
  macrocycleNum: number;
  /**
   * The macrocycle's stable id, sent with every write and used to key drafts, so a page left
   * open across a renumbering can't write into another macrocycle (#1198).
   */
  macrocycleId?: string;
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
  /**
   * Each modification's own max in this program, in lbs, by modification id (#1153). `null` when
   * the read failed: an `own` toggle then plans from the lift's max and says why.
   */
  ownMaxes: Readonly<Record<string, number>> | null;
}
