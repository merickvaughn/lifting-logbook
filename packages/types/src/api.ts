import { BodyWeightEntry, LiftClassification, LiftModificationMaxMode, LiftName, MovementProfile, WeightUnit, WeekNumber, MacrocycleNumber, MacrocycleOrigin, MacrocycleStatus, WeekType } from './domain';
import { DefaultProgressionSetting, LiftProgressionType } from './progression';

// ---------------------------------------------------------------------------
// Training Maxes
// ---------------------------------------------------------------------------

/** Serialized training max as returned by the API. */
export interface TrainingMaxResponse {
  lift: LiftName;
  weight: number;
  unit: WeightUnit;
  dateUpdated: string; // ISO 8601 date string
}

/** A TM reduction that was blocked and requires explicit user review (mirrors core's MaxReductionFlag). */
export interface MaxReductionFlagResponse {
  lift: LiftName;
  currentWeight: number;
  proposedWeight: number;
  /** Set when the max is a modification's own (#1153); `lift` is then the set's lift. */
  modificationId?: string;
}

/** A lift recalculation left alone (mirrors core's SkippedLift, #1150). */
export interface SkippedLiftResponse {
  /** The lift as its records name it. */
  lift: LiftName;
  /**
   * It has no training max; the program has no spec row for it and nothing else gave it a rule;
   * or, off-program, its progression type needs a rep target and none resolved (#1211).
   */
  reason: 'no-training-max' | 'no-program-spec' | 'no-target-reps';
}

/**
 * A lift with logged sets in the program and no training max (#1246), from
 * `GET /programs/:program/training-maxes/missing`. Weights are in pounds, the stored unit.
 */
export interface MissingTrainingMaxResponse {
  /**
   * The lift as its latest set stores it, often an id (`bench-press`, or a custom lift's UUID): the
   * value to save its max under, so the max matches its sets. Not for display; see `name`.
   */
  lift: LiftName;
  /** The name to show: the catalog's or the custom lift's, else `lift` as stored (#1290). */
  name: string;
  /** Its stable id (#1139), which a dismissal is keyed by. */
  liftId: string;
  /** ISO 8601 date ("YYYY-MM-DD") of its latest set. */
  lastLoggedDate: string;
  setCount: number;
  /** A starting max from its sets in the 8 weeks up to its latest, or null with no usable set. */
  estimate: { weight: number; unit: WeightUnit; from: { date: string; weight: number; reps: number } } | null;
  /** The lifter answered "Don't ask again": prompts leave it out, and settings lists it apart. */
  dismissed: boolean;
}

/** Response from POST /training-maxes/recalculate. */
export interface RecalculateMaxesResponse {
  maxes: TrainingMaxResponse[];
  /** Lifts whose computed new TM would be lower than the current TM — not auto-applied. */
  flagged: MaxReductionFlagResponse[];
  /** Lifts with logged sets that nothing progressed: no training max, or no rule or rep target to progress them by. */
  skipped: SkippedLiftResponse[];
}

/** Request body for updating one or more training maxes. */
export interface UpdateTrainingMaxesRequest {
  maxes: Array<{
    lift: LiftName;
    weight: number;
    unit: WeightUnit;
  }>;
}

// ---------------------------------------------------------------------------
// Training Max History
// ---------------------------------------------------------------------------

export type TrainingMaxHistorySource = 'test' | 'program';

/** A single entry in the training max history timeline. */
export interface TrainingMaxHistoryEntryResponse {
  id: string;
  lift: LiftName;
  weight: number;
  unit: WeightUnit;
  date: string; // ISO 8601 date string
  isPR: boolean;
  source: TrainingMaxHistorySource;
  goalMet: boolean;
}

/** Response from GET /training-maxes/history. */
export interface TrainingMaxHistoryResponse {
  entries: TrainingMaxHistoryEntryResponse[];
}

/** Request body for PATCH /training-maxes/history/:id. */
export interface UpdateTrainingMaxHistoryRequest {
  isPR?: boolean;
  goalMet?: boolean;
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

/** A single set within a workout. */
export interface SetResponse {
  /**
   * The logged record's id — the same value as {@link LiftRecordResponse.id},
   * valid for `PATCH /programs/:program/lift-records/:id`. Built from the
   * stored record, so under a `replace` lift override it still addresses the
   * row as persisted (the lift the set is grouped under may be the replacement).
   */
  id: string;
  setNum: number;
  weight: number;
  reps: number;
  amrap: boolean;
  /** Free-text notes on the logged record; `''` when none. */
  notes: string;
  /** The modifications on for this set, present only when there are any. */
  modifications?: LiftModificationRef[];
}

/** A single lift's sets within a workout. */
export interface WorkoutLiftResponse {
  lift: LiftName;
  sets: SetResponse[];
  /** True when derived from the program spec with no logged sets yet; false when backed by real records. */
  planned: boolean;
  /**
   * The lift whose slot this one took, present only when a Manage Lifts
   * `replace` put it here (followed back through a chain of swaps): a spec lift,
   * or a lift added through Manage Lifts, whose slot has no prescription (#1026).
   * A swap changes the movement, not the slot: resolve this lift's prescription
   * by this name, and price it from `lift`'s own training max (issue #1014).
   */
  replaces?: LiftName;
  /**
   * Which occurrence of `lift` in this workout, from 0, present only above 0: a
   * program can plan one lift twice in a day, and each occurrence lists its own
   * sets (#1027). Log a set against an occurrence by sending this value back in
   * {@link CreateLiftRecordRequest.occurrence}.
   */
  occurrence?: number;
  /**
   * The lift's latest session before this workout, which a `double` lift plans from (#1211):
   * another workout in this macrocycle dated on or before this one (by its `overrideDate`
   * when rescheduled), under any spelling of the lift, counting only the lift's first
   * occurrence in it. Its date (`YYYY-MM-DD`) and each set's reps, by set number. Absent
   * when the lift has none (#1252).
   */
  lastSession?: { date: string; reps: number[] };
}

/**
 * The request header a page sends its macrocycle's stable id in
 * ({@link WorkoutResponse.macrocycleId}, #1198). The API's CORS config allows it.
 */
export const MACROCYCLE_ID_HEADER = 'X-Macrocycle-Id';

/** Serialized workout as returned by the API. */
export interface WorkoutResponse {
  program: string;
  macrocycleNum: MacrocycleNumber;
  /**
   * The macrocycle's stable id, which a renumbering doesn't change. Every write a workout page
   * makes sends it, so a page left open can't write into another macrocycle (#1198). Absent
   * when the program has no macrocycle yet.
   */
  macrocycleId?: string;
  workoutNum: number;
  /** The *program* week — past the stored block, for a tiled program. */
  week: WeekNumber;
  /**
   * The workout's day within its week: the `offset` of the spec rows that plan
   * it. `GET /programs/:program/spec` serves the one untiled block, so resolve
   * those rows through the block week — `specRowsForWorkoutDay` in
   * `@lifting-logbook/core` (issue #1014).
   * - `null`: the program has no day for this workout (a scheduled workout past
   *   the program's last day, #1023). It plans no lifts, and nothing on it has
   *   a prescription.
   * - Absent: only from an API that predates this field.
   */
  offset?: number | null;
  date: string; // ISO 8601 date string
  overrideDate?: string; // ISO 8601 date string; present when the user has rescheduled
  skipped: boolean;
  lifts: WorkoutLiftResponse[];
  bodyWeightEntry?: Pick<BodyWeightEntry, 'weight' | 'unit'>;
}

/**
 * Request body for PATCH
 * /programs/:program/macrocycles/:macrocycleNum/workouts/:workoutNum/reschedule.
 *
 * Shared contract for the reschedule request shape: the backend `RescheduleDto`
 * (`apps/api`) implements this interface and the api-client builds its request
 * body as this type, so the two cannot drift. The endpoint returns 204 No
 * Content, so there is no corresponding response type — the reschedule result is
 * surfaced on the read side via `WorkoutResponse.overrideDate` and
 * `MacrocycleDashboardResponse.dateOverrides`.
 */
export interface RescheduleRequest {
  /** Target calendar date in `YYYY-MM-DD` format (no time or timezone component). */
  newDate: string;
}

// ---------------------------------------------------------------------------
// Lift Records
// ---------------------------------------------------------------------------

/** Serialized lift record as returned by the API. */
export interface LiftRecordResponse {
  id: string;
  program: string;
  macrocycleNum: MacrocycleNumber;
  workoutNum: number;
  date: string; // ISO 8601 date string
  lift: LiftName;
  /** Which occurrence of `lift` in its workout, from 0; present only above 0 (#1027). */
  occurrence?: number;
  setNum: number;
  weight: number;
  reps: number;
  notes: string;
  /** The modifications on for this set, present only when there are any. */
  modifications?: LiftModificationRef[];
}

/** Request body for logging a new lift record. */
export interface CreateLiftRecordRequest {
  program: string;
  macrocycleNum: MacrocycleNumber;
  workoutNum: number;
  /** Bare calendar date ("YYYY-MM-DD", no time/offset — see CreateLiftRecordDto.date in apps/api). When omitted the server uses the scheduled date for this workout, falling back to today. */
  date?: string;
  lift: LiftName;
  /** The workout lift's {@link WorkoutLiftResponse.occurrence}; omit for its first occurrence. */
  occurrence?: number;
  setNum: number;
  weight: number;
  reps: number;
  notes?: string;
  /**
   * The ids of the modifications on for this set. Each must belong to this user and to `lift`,
   * with at most one whose `maxMode` is `own`. Omit when there are none.
   */
  modifications?: string[];
}

// ---------------------------------------------------------------------------
// Non-cycle workouts (#1184): training outside any program, stored under the reserved program
// NON_CYCLE_PROGRAM in one macrocycle numbered 1. Later sets go through
// `POST /programs/non-cycle/lift-records` with the workout's number and date, and edits through
// `PATCH /programs/non-cycle/lift-records/:id`, both sending `macrocycleId`.
// ---------------------------------------------------------------------------

/** Request body for `POST /non-cycle-workouts`: the workout's date and its first set. */
export interface CreateNonCycleWorkoutRequest {
  /** The lifter's local calendar day ("YYYY-MM-DD"), no more than one day past the server's. */
  date: string;
  lift: LiftName;
  occurrence?: number;
  setNum: number;
  weight: number;
  reps: number;
  notes?: string;
  modifications?: string[];
}

/** One non-cycle workout and its sets. */
export interface NonCycleWorkoutResponse {
  workoutNum: number;
  /** ISO 8601 date. */
  date: string;
  /** The non-cycle macrocycle's stable id, sent with every write to the workout (#1198). */
  macrocycleId: string;
  /** In lift then set order. */
  records: LiftRecordResponse[];
}

/**
 * What a non-cycle workout shows beside a lift for reference (decision 23): its training max in
 * the active program, and the previous max with the reps last performed at it. Weights are in
 * pounds, the stored unit. `null` when the active program has no max for the lift.
 */
export interface NonCycleReferenceResponse {
  lift: LiftName;
  reference: { trainingMax: number; previous: { weight: number; reps: number } | null } | null;
}

/** Request body for updating an existing lift record (in-session editing). */
export interface UpdateLiftRecordRequest {
  weight?: number;
  reps?: number;
  notes?: string;
  /** Replaces the set's list, under the rules on {@link CreateLiftRecordRequest.modifications}. */
  modifications?: string[];
}

// ---------------------------------------------------------------------------
// Body Weight
// ---------------------------------------------------------------------------

/** Request body for recording a body weight observation. */
export interface RecordBodyWeightRequest {
  date: string; // Bare calendar date ("YYYY-MM-DD", no time/offset — see RecordBodyWeightDto.date in apps/api)
  weight: number;
  unit: WeightUnit;
}

/** Serialized body weight entry as returned by the API. */
export interface BodyWeightResponse {
  date: string; // ISO 8601 date string ("YYYY-MM-DD")
  weight: number;
  unit: WeightUnit;
}

// ---------------------------------------------------------------------------
// Strength Goals
// ---------------------------------------------------------------------------

/** Serialized strength goal as returned by the API. */
export interface StrengthGoalResponse {
  lift: string;
  goalType: 'absolute' | 'relative';
  target?: number;
  unit: 'lbs' | 'kg';
  ratio?: number;
  updatedAt: string; // ISO 8601 date string
}

/** Request body for PUT /programs/:program/strength-goals/:lift. */
export interface UpsertStrengthGoalRequest {
  goalType: 'absolute' | 'relative';
  target?: number;
  unit: 'lbs' | 'kg';
  ratio?: number;
}

// ---------------------------------------------------------------------------
// Macrocycle Dashboard
// ---------------------------------------------------------------------------

/** Per-workout entry within a macrocycle week summary. */
export interface WorkoutSummary {
  workoutNum: number;
  /**
   * ISO 8601 date: the override if the workout was rescheduled, else the date its
   * schedule gave it, else, for a day the schedule gave no date, its spec-relative
   * date.
   */
  date: string;
  skipped: boolean;
}

/** Per-week summary within a macrocycle dashboard. */
export interface MacrocycleWeekSummary {
  /**
   * The *program* week, the week the Macrocycle Dashboard grid and the workout
   * endpoint show these workouts in. It is not the calendar week they fall in,
   * since a schedule sets its own pace (issue #1023, ADR-037).
   */
  week: WeekNumber;
  workouts: WorkoutSummary[];
  completed: boolean;
}

/** One macrocycle, past or current, from `GET /programs/:program/macrocycles` (ADR-042). */
export interface MacrocycleSummaryResponse {
  /** Stable across renumbering; the number isn't. */
  id: string;
  macrocycleNum: MacrocycleNumber;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`, or null while current or when nothing dates the end. */
  endDate: string | null;
  /**
   * As it reads today: an `in-progress` macrocycle whose last session is more than 14 days old
   * reads as `abandoned`, unless it's current or the lifter chose the status.
   */
  status: MacrocycleStatus;
  origin: MacrocycleOrigin;
  /** The dashboard points at it. */
  current: boolean;
  unmatched: boolean;
}

/** Serialized macrocycle dashboard as returned by the API. */
export interface MacrocycleDashboardResponse {
  program: string;
  macrocycleNum: MacrocycleNumber;
  macrocycleStartDate: string; // ISO 8601 date string
  /**
   * With a schedule, every workout of the program, grouped by program week. With
   * none, empty. A scheduled row past the program's last day is not a workout of
   * the program, so it is left out (issue #1023).
   */
  weeks: MacrocycleWeekSummary[];
  currentWeekType: WeekType;
  /**
   * Per-workout metadata for the *whole* macrocycle, in both schedule and no-schedule
   * modes — `weeks` is empty in no-schedule mode, so the Macrocycle Dashboard reads
   * these to render every tiled workout's status without a per-workout fetch
   * (issue #740). Keys are global `workoutNum`s.
   *
   * These three are the canonical per-workout source of truth. The per-week
   * `weeks[].workouts[].date` / `.skipped` fields are a schedule-mode display
   * projection derived from the same override/skip data — prefer these top-level
   * maps in new consumers.
   */
  /** `workoutNum` → override date (ISO 8601). Absent key = no override. */
  dateOverrides: Record<number, string>;
  /** `workoutNum`s explicitly skipped in this macrocycle. */
  skippedWorkoutNums: number[];
  /** `workoutNum`s with at least one logged lift record in this macrocycle. */
  completedWorkoutNums: number[];
}

// ---------------------------------------------------------------------------
// Macrocycle Planning Agent
// ---------------------------------------------------------------------------

/** A single proposed training-max change within a macrocycle plan. */
export interface ProposedTrainingMaxChangeResponse {
  lift: LiftName;
  currentWeight: number;
  proposedWeight: number;
  reasoning: string;
}

/** Result of a macrocycle planning agent run. */
export interface MacrocyclePlanResponse {
  proposedChanges: ProposedTrainingMaxChangeResponse[];
  overallReasoning: string;
  partial: boolean;
  partialReason?: string;
}

// ---------------------------------------------------------------------------
// Lifting Program Spec
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lift Overrides (Manage Lifts)
// ---------------------------------------------------------------------------

export type LiftOverrideAction = 'add' | 'remove' | 'replace';

/** Request body for POST /programs/:program/macrocycles/:macrocycleNum/workouts/:workoutNum/lift-overrides. */
export interface CreateLiftOverrideRequest {
  action: LiftOverrideAction;
  lift: string;
  /** Required when action is 'replace'. */
  replacedBy?: string;
}

/** A single lift override as returned by the API. */
export interface LiftOverrideResponse {
  action: LiftOverrideAction;
  lift: string;
  replacedBy?: string;
}

// ---------------------------------------------------------------------------
// Lift Metadata
// ---------------------------------------------------------------------------

/** Per-user lift metadata as returned by GET /lifts/:lift/metadata. */
export interface LiftMetadataResponse {
  lift: string;
  muscleGroups: string[];
  substitutions: string[];
  foundational: boolean;
  /**
   * The lift's own progression (#1210). Null means the lifter's default, then the catalog's,
   * applies (docs/adr/ADR-043-lift-progression-resolution-and-storage.md).
   */
  progression: LiftProgressionType | null;
  /** The lift's own increment off-program. Null falls back to the default's, then `defaultWeightIncrement`. */
  progressionIncrement: number | null;
  repsLow: number | null;
  repsHigh: number | null;
}

/**
 * Request body for PATCH /lifts/:lift/metadata. An omitted field is left unchanged; `null`
 * clears a progression field.
 */
export interface PatchLiftMetadataRequest {
  muscleGroups?: string[];
  substitutions?: string[];
  foundational?: boolean;
  progression?: LiftProgressionType | null;
  progressionIncrement?: number | null;
  repsLow?: number | null;
  repsHigh?: number | null;
}

// ---------------------------------------------------------------------------
// Lifting Program Spec
// ---------------------------------------------------------------------------

/** Per-lift specification within a lifting program (e.g., 5/3/1). */
export interface LiftingProgramSpecResponse {
  week: number;
  lift: LiftName;
  order: number;
  offset: number;
  increment: number;
  sets: number;
  reps: number;
  amrap: boolean;
  warmUpPct: string;
  wtDecrementPct: number;
  activation: string;
  /** The row's progression override (#1210). Absent means the lift's own value applies. */
  progression?: LiftProgressionType;
  /** The bottom of the row's rep range; `reps` is the top. */
  repsLow?: number;
}

// ---------------------------------------------------------------------------
// User Settings
// ---------------------------------------------------------------------------

/**
 * Day-of-week convention used throughout the schedule subsystem.
 * 0 = Monday … 6 = Sunday.
 *
 * IMPORTANT: do NOT use JavaScript's `Date.getDay()` directly — it returns
 * 0=Sunday. Convert via `(d.getDay() + 6) % 7` to land in this convention.
 */
export const DAY_INDEX = {
  MON: 0,
  TUE: 1,
  WED: 2,
  THU: 3,
  FRI: 4,
  SAT: 5,
  SUN: 6,
} as const;

/** Upper bounds enforced at both the write (DTO) and read (parseSchedule) boundaries. */
export const SCHEDULE_LIMITS = {
  MAX_DAYS_PER_WEEK: 7,
  MAX_ROTATING_WEEKS: 8,
} as const;

export interface UserWorkoutSchedule {
  type: 'fixed' | 'rotating';
  /** For fixed schedules: array of day indices using `DAY_INDEX` (0=Mon … 6=Sun). */
  days?: number[];
  /** For rotating schedules: array of week patterns, each containing day indices. */
  weeks?: number[][];
}

/**
 * Single source of truth for `UserWorkoutSchedule` shape validation.
 * Used by the API DTO write-side check and the repository read-side guard
 * so the two boundaries cannot drift (e.g., upper bounds tightened in only
 * one place). Returns the value narrowed to `UserWorkoutSchedule` when valid.
 */
export function isValidSchedule(value: unknown): value is UserWorkoutSchedule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as { type?: unknown; days?: unknown; weeks?: unknown };
  const isDayIdx = (d: unknown): d is number =>
    Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6;

  if (v.type === 'fixed') {
    if (v.weeks !== undefined) return false;
    if (!Array.isArray(v.days)) return false;
    if (v.days.length < 1 || v.days.length > SCHEDULE_LIMITS.MAX_DAYS_PER_WEEK) return false;
    const seen = new Set<number>();
    for (const d of v.days) {
      if (!isDayIdx(d) || seen.has(d)) return false;
      seen.add(d);
    }
    return true;
  }

  if (v.type === 'rotating') {
    if (v.days !== undefined) return false;
    if (!Array.isArray(v.weeks)) return false;
    if (v.weeks.length < 1 || v.weeks.length > SCHEDULE_LIMITS.MAX_ROTATING_WEEKS) return false;
    for (const week of v.weeks) {
      if (!Array.isArray(week)) return false;
      if (week.length < 1 || week.length > SCHEDULE_LIMITS.MAX_DAYS_PER_WEEK) return false;
      const seen = new Set<number>();
      for (const d of week) {
        if (!isDayIdx(d) || seen.has(d)) return false;
        seen.add(d);
      }
    }
    return true;
  }

  return false;
}

export interface UserSettingsResponse {
  activeProgram: string | null;
  workoutSchedule: UserWorkoutSchedule | null;
  /** Null when unset — callers fall back to 1.25 (see docs/standards/training-max-precision.md). */
  defaultWeightIncrement: number | null;
  /** Null when unset — callers fall back to 'lbs' (see DEFAULT_WEIGHT_UNIT). Display preference only; stored weights are unaffected. */
  unit: WeightUnit | null;
  /** Null when unset: each lift's catalog default applies (#1210). */
  defaultProgression: DefaultProgressionSetting | null;
}

export interface UpdateUserSettingsRequest {
  workoutSchedule?: UserWorkoutSchedule | null;
  defaultWeightIncrement?: number | null;
  unit?: WeightUnit | null;
  /** Replaces the whole default; `null` clears it so the catalog applies again. */
  defaultProgression?: DefaultProgressionSetting | null;
}

/** The only values `defaultWeightIncrement` may take, matching plate sizes users actually have. */
export const WEIGHT_INCREMENT_OPTIONS = [0.625, 1.25, 2.5, 5] as const;

export const DEFAULT_WEIGHT_INCREMENT = 1.25;

/** The only values the global `unit` preference may take. */
export const WEIGHT_UNIT_OPTIONS = ['lbs', 'kg'] as const;

export const DEFAULT_WEIGHT_UNIT: WeightUnit = 'lbs';

// ---------------------------------------------------------------------------
// Custom Programs
// ---------------------------------------------------------------------------

export interface CustomProgramSpecRow {
  week: number;
  offset: number;
  lift: string;
  increment: number;
  order: number;
  sets: number;
  reps: number;
  amrap: boolean;
  warmUpPct: string;
  wtDecrementPct: number;
  activation: string;
  weekType?: string;
  /**
   * The row's progression override (#1210). Unset means the lift's own value applies. A
   * response leaves it out when unset. In a request, null sets it unset; an update that leaves
   * it out keeps the stored value, for a client that predates the field.
   */
  progression?: LiftProgressionType | null;
  /**
   * The bottom of the row's rep range; `reps` is the top. Set and left out like `progression`,
   * except that a kept value above the row's `reps` is cleared.
   */
  repsLow?: number | null;
}

export interface CustomProgramResponse {
  id: string;
  name: string;
  description: string | null;
  baseTemplate: string | null;
  createdAt: string;
  specs: CustomProgramSpecRow[];
}

export interface CustomProgramSummaryResponse {
  id: string;
  name: string;
  description: string | null;
  baseTemplate: string | null;
  createdAt: string;
}

export interface CreateCustomProgramRequest {
  name: string;
  description?: string;
  baseTemplate?: string;
  specs: CustomProgramSpecRow[];
}

export interface UpdateCustomProgramRequest {
  name?: string;
  description?: string;
  specs?: CustomProgramSpecRow[];
}

export interface SwitchProgramResponse {
  activeProgram: string;
  macrocycleNum: number;
}

// ---------------------------------------------------------------------------
// Lift Record CSV Import
// ---------------------------------------------------------------------------

/**
 * Machine-readable reason for an {@link ImportError}, stable across validator wording
 * changes. `ImportError.field` is a free-form string with no compile-time guarantee
 * the producing validator still emits that exact value — #911's `IMPORT_ERROR_FIELD_LIFT`
 * constant hardens the *value* against typos, but nothing stops a validator from
 * omitting `field` altogether on a new error site, silently breaking any branch keyed
 * off it. `code` is required on every `ImportError`, closing that gap: a UI branch
 * that needs to react to a specific failure (e.g. gating an affordance) should key off
 * `code`, not `field`. See #913.
 */
export type ImportErrorCode =
  | 'MACROCYCLE_NUM_INVALID'
  | 'WORKOUT_NUM_INVALID'
  | 'SET_NUM_INVALID'
  | 'WEIGHT_INVALID'
  | 'REPS_INVALID'
  | 'DATE_INVALID'
  | 'UNRECOGNIZED_LIFT'
  | 'LIFT_EMPTY'
  | 'GOAL_TYPE_INVALID'
  | 'TARGET_INVALID'
  | 'RATIO_INVALID'
  | 'UNIT_INVALID'
  | 'WEEK_INVALID'
  | 'OFFSET_INVALID'
  | 'INCREMENT_INVALID'
  | 'ORDER_INVALID'
  | 'SETS_INVALID'
  | 'WT_DECREMENT_PCT_INVALID'
  | 'WEEK_TYPE_INVALID'
  | 'FILE_PARSE_FAILED'
  | 'ROW_LIMIT_EXCEEDED'
  | 'OCCURRENCE_INVALID'
  | 'STATUS_INVALID'
  | 'UNEXPECTED_ERROR';

/** A single validation error from a CSV import attempt. */
export interface ImportError {
  /** 1-based data row number (excludes the header row). */
  row: number;
  /** Which field failed, if determinable. */
  field?: string;
  /** Machine-readable failure reason — see {@link ImportErrorCode}. */
  code: ImportErrorCode;
  message: string;
}

/**
 * The `ImportError.field` value used for an unrecognized lift name
 * (validateLiftImport.ts). Shared as a named constant — not a bare `'lift'`
 * string literal — so a UI keying an affordance off this value (e.g.
 * LiftRecordsImportForm's Smart Import Wizard link) can't silently stop
 * matching if the producing end is ever renamed, with no type error at
 * either end to catch it (issue #911 review). `ImportError.field` stays a
 * free-form `string`, not a full field-name union, since several other
 * validators (training-maxes, strength-goals, program-spec) each have their
 * own distinct field sets this constant does not attempt to enumerate.
 */
export const IMPORT_ERROR_FIELD_LIFT = 'lift' as const;

/** A row that was silently skipped because its natural key already exists. */
export interface SkippedRecord {
  /**
   * 1-based data row number, counting only data rows (the CSV header is excluded).
   * Row 1 is the first data row immediately after the header.
   */
  row: number;
  /**
   * Stringified natural key identifying the skipped set, in the format:
   * `"<macrocycleNum>:<workoutNum>:<YYYYMMDD>:<lift>:<setNum>"`
   *
   * All components use the canonical (post-import, post-slot-map) values. `date`
   * is part of the key (issue #884): two sets can otherwise legitimately share
   * the same (macrocycleNum, workoutNum, lift, setNum) tuple on different real
   * calendar dates and must not be treated as duplicates of each other.
   * Example: `"3:2:20260817:bench-press:1"` means macrocycle 3, workout 2,
   * 2026-08-17, bench-press, set 1.
   *
   * For matching, not display: the lift's segment is its id. Show `label`.
   */
  naturalKey: string;
  /**
   * The skipped set as a person reads it, naming the lift rather than its id
   * (issues #1158, #1162). Same wording as the row's `ImportDelta.label` on the Review step.
   */
  label: string;
}

/** Response body for a successful POST /programs/:program/lift-records/import. */
export interface ImportLiftRecordsResponse {
  /** Number of rows actually inserted (excludes duplicates that were skipped). */
  written: number;
  /**
   * Rows that were not inserted because their natural key already exists in the database.
   * Empty array when there are no duplicates.
   *
   * Note: lift abbreviations (e.g. "Bench P.") are resolved to canonical lift IDs
   * (e.g. "bench-press") before the natural key is computed, so the values here
   * reflect the stored canonical IDs, not the original CSV values.
   *
   * Programs do not restrict which lifts may be imported. Preloaded template programs
   * become custom programs when edited; custom programs have no lift restrictions.
   */
  skipped: SkippedRecord[];
}

// ---------------------------------------------------------------------------
// Smart File Import (multi-type wizard) — #477
// ---------------------------------------------------------------------------

/**
 * The four destinations the Smart Import wizard can route a CSV to. Mirrors the
 * four CSV exports the app stores: lift history, training maxes, strength goals,
 * and a program spec.
 */
export type ImportKind =
  | 'lift-records'
  | 'training-maxes'
  | 'strength-goals'
  | 'program-spec';

/** Confidence bucket for a classification, derived from per-type thresholds. */
export type ImportConfidenceBucket = 'high' | 'medium' | 'low';

/** A rejected classification candidate, surfaced under "Other possibilities considered". */
export interface ImportAlternative {
  type: ImportKind;
  /** This candidate's own confidence (0–1), independent of the winner's. */
  confidence: number;
  /** True when this candidate scored within a small margin of the winner. */
  closeCall: boolean;
}

/**
 * Result of running the signal-based classifier over a parsed CSV table.
 *
 * `type` is `null` only when no candidate cleared its per-type auto-accept
 * threshold (a low-confidence / no-winner result); the wizard then asks the
 * user to pick a destination or skip the file. It never auto-routes.
 */
export interface ImportClassification {
  type: ImportKind | null;
  /** Winning candidate's confidence (0–1); the top score even when below auto-accept. */
  confidence: number;
  bucket: ImportConfidenceBucket;
  /** Human-readable explanations of the signals that fired ("Why this classification"). */
  reasons: string[];
  /** Other destinations considered, ranked by their own confidence. */
  alternatives: ImportAlternative[];
}

/**
 * Row-level status for the interactive REVIEW step (Phase 3).
 *
 * `undated`: a lift-record row with no date, under the Assign step (#1253). It can't be placed
 * in a macrocycle, so it's left out of the import and counted, rather than held at the
 * incomplete-row gate. Excluding it at Review changes nothing it would write.
 */
export type ImportRowStatus = 'ok' | 'incomplete' | 'ambiguous' | 'undated';

/** A single before→after row in a preview diff, formatted for display. */
export interface ImportDelta {
  /** Stable identity of the affected entity (lift id, spec-row natural key, …). */
  key: string;
  /** Display label (e.g. "Back Squat", "Week 1 · Bench Press"). */
  label: string;
  kind: 'create' | 'update' | 'skip';
  /** Prior stored value, present for updates and skips; absent for creates. */
  before?: string;
  /** Incoming value from the imported file. */
  after?: string;
  /** Phase 3: row health; undefined means 'ok'. */
  status?: ImportRowStatus;
  /**
   * Phase 3: 1-based position among the parsed rows (used by liftOverrides and
   * `__row_<rowIndex>` excludeKeys on commit). It is the CSV data row for lift records. It
   * isn't for program specs, which parse sorted, or strength goals, which skip non-lift
   * rows, so don't display it for those. Absent on training-max deltas, which are sorted by date.
   */
  rowIndex?: number;
  /** Phase 3: original unresolved lift name, populated on 'ambiguous' rows. */
  originalLift?: string;
}

/** Aggregate counts plus per-row deltas for a previewed import. */
export interface ImportPreview {
  creates: number;
  updates: number;
  skips: number;
  /**
   * Incomplete or ambiguous rows in the file as uploaded. The commit rejects the file until
   * each is fixed or excluded. The wizard's Preview step tracks the user's fixes on top of this.
   */
  unresolved: number;
  deltas: ImportDelta[];
  /** Training-max rows under different spellings of one lift; absent when there are none. */
  spellingCollisions?: ImportSpellingCollision[];
  /** Strength-goal rows under different spellings of one lift; absent when there are none. */
  goalSpellingCollisions?: ImportGoalSpellingCollision[];
}

/**
 * Rows of one training-max file that spell one lift differently (`Squat` and `Back Squat`), so
 * they can't all apply as its max. The user can keep any of them as a custom lift (#1135).
 */
export interface ImportSpellingCollision {
  /** The lift's identity: its catalog id. */
  key: string;
  /** Display name of the lift. */
  label: string;
  /** The newest row for each spelling, most recent first. */
  rows: {
    spelling: string;
    /** The stored `lift` this row writes to. Two rows can share one, and the first stores. */
    lift: string;
    weight: number;
    dateUpdated: string;
  }[];
}

/**
 * Rows of one strength-goal file that spell one lift differently, so they can't all apply as its
 * goal. The user can keep any of them as a custom lift, through `liftOverrides` (#1169).
 */
export interface ImportGoalSpellingCollision {
  /** The lift's identity: its catalog id. */
  key: string;
  /** Display name of the lift. */
  label: string;
  /** One entry per spelling, in file order. */
  rows: {
    spelling: string;
    /** The stored `lift` this spelling writes to. Two can share one, and the first stores. */
    lift: string;
    /** The goal from this spelling's first row, as a preview shows it. */
    value: string;
    /** Every row with this spelling, as positions among the parsed rows. */
    rowIndexes: number[];
  }[];
}

/**
 * Response for `POST /programs/:program/import?mode=preview` — writes nothing.
 *
 * `destination` is the resolved target: the classifier winner when it clears its
 * auto-accept threshold, the client's `?destination=` override otherwise, or
 * `null` when the result is low-confidence and no override was supplied (in which
 * case `preview` is also `null` and the wizard prompts for a manual pick).
 */
/**
 * A single column mapping from a source CSV header to a canonical destination field.
 * Returned in `ImportPreviewResponse.columnMappings` when a destination is resolved.
 */
export interface ColumnMapping {
  /** Original CSV column header from the uploaded file (empty string for unmapped required fields). */
  sourceHeader: string;
  /** Canonical destination field key (e.g., "lift", "weight", "date"); empty when no match found. */
  destinationField: string;
  /** Confidence score (0–1) that this mapping is correct. */
  confidence: number;
  /** True if this field must be mapped before the user can proceed to REVIEW. */
  required: boolean;
  /** Human-readable note about data transformations that will be applied (normalization, split, etc.). */
  transformationNote?: string;
  /** Up to 2 alternative field matches with lower confidence (omitted when no alternatives exist). */
  alternatives?: Array<{
    field: string;
    confidence: number;
  }>;
}

export interface ImportPreviewResponse {
  classification: ImportClassification;
  destination: ImportKind | null;
  /**
   * Column mappings computed for each source header, present only when destination is resolved.
   * Each entry maps one CSV column to a canonical field with a confidence score.
   * Unmapped required fields appear with `sourceHeader: ''` and `confidence: 0`.
   */
  columnMappings: ColumnMapping[] | null;
  preview: ImportPreview | null;
  /** Per-row validation errors for the resolved destination, surfaced as data (not a 400). */
  errors: ImportError[];
  /**
   * Phase 3: split destination preview, populated when lift-records rows are
   * automatically routed to a second destination (e.g. 1RM Test rows → Training Maxes).
   */
  split?: {
    destination: ImportKind;
    preview: ImportPreview;
  };
  /**
   * Whether `IMPORT_ASSIGN_ENABLED` is on (#1253). When it is, a lift-records file goes through
   * the Assign step, so its program, macrocycle and workout columns aren't required. Absent
   * means off.
   */
  assignEnabled?: boolean;
}

/**
 * Counts returned by an idempotent batch import write — shared by every commit
 * destination and by the per-kind repository write methods (so commit counts come
 * from the write result itself, not a separate pre-read).
 */
export interface ImportWriteResult {
  /** Rows newly inserted. Re-running the same file yields 0 (idempotent). */
  created: number;
  /** Rows whose prior value was overwritten (upsert kinds only; 0 for append-only lift records). */
  updated: number;
  /** Rows skipped because they were identical to the stored value / a duplicate. */
  skipped: number;
}

/** Response for `POST /programs/:program/import?mode=commit`. */
export interface ImportCommitResponse extends ImportWriteResult {
  destination: ImportKind;
  /** Phase 3: UUID of the ImportBatch record; null if the batch save failed (import still succeeds). */
  batchId: string | null;
  /**
   * Phase 3: counts for rows automatically split to a second destination
   * (e.g. 1RM Test lift-records rows committed to Training Maxes).
   */
  split?: { destination: ImportKind; created: number; updated: number; skipped: number };
  /**
   * Per-row detail for rows skipped during commit, mirroring the legacy
   * `POST /programs/:program/lift-records/import` endpoint's
   * `ImportLiftRecordsResponse.skipped` (issue #891). Populated only when
   * `destination === 'lift-records'` (always present there, possibly empty)
   * — the other three destinations are upsert kinds where "skipped" means
   * "identical to the already-stored value" rather than "blocked by a
   * distinct pre-existing row", so a natural-key skip list isn't meaningful
   * for them yet; the field is absent (not an empty array) for those.
   *
   * `row` is 1-based within the batch actually committed (after any Phase 3
   * `excludeKeys`/`splitDest` filtering already applied upstream) — for a
   * plain commit using neither, it matches the original CSV data-row number.
   */
  skippedDetail?: SkippedRecord[];
  /** Present when the commit stored an Assign breakdown (#1254). */
  assigned?: ImportAssignedCounts;
  /**
   * Each lift this commit wrote a set for in the program it was made in, once, as stored (a lift
   * id, such as `bench-press`). The import result asks which of them have no training max
   * (`GET …/training-maxes/missing?lifts=…` takes ids) (#1246, #1273). Present only when
   * `destination === 'lift-records'`; sets written to another program or as non-cycle workouts
   * aren't listed, since that program's list wouldn't count them.
   */
  lifts?: string[];
}

/**
 * Response for `POST /programs/:program/import?mode=dry-run`: the counts a commit with
 * the same inputs would return. Nothing is written (#1123).
 */
export interface ImportDryRunResponse extends ImportWriteResult {
  destination: ImportKind;
  /** Counts for rows split to a second destination, as on {@link ImportCommitResponse}. */
  split?: { destination: ImportKind; created: number; updated: number; skipped: number };
  /** Present when the dry run took an Assign breakdown (#1254). */
  assigned?: ImportAssignedCounts;
}

/** What an import with an Assign breakdown does beyond the row counts (#1254). */
export interface ImportAssignedCounts {
  /** Macrocycles created: one per stretch with a new row that joins no stored macrocycle. */
  macrocycles: number;
  /** Stored macrocycles that a stretch's new rows joined, extending them (#1255, decision 14). */
  extended: number;
  /** Sessions stored as non-cycle workouts. */
  nonCycleSessions: number;
  /** Sessions the lifter left out. */
  excludedSessions: number;
  /** Rows with no date, left out (decision 16). */
  undatedRows: number;
  /** Rows skipped as duplicates whose weight or reps differ from the stored set, which stays as stored. */
  changed: number;
  /** One-rep-max rows split to training maxes and skipped as older than that program's current max. */
  splitOlderThanCurrent: number;
}

/**
 * One confirmed macrocycle in an Assign breakdown (#1254, proposal decision 17). It names its
 * sessions by date, or for an exported file, whose macrocycles can share a date, by the file's
 * program and macrocycle number.
 */
export interface ImportBreakdownStretch {
  /** The program it's stored under. */
  program: string;
  /** Its session dates, `YYYY-MM-DD`. */
  dates?: string[];
  /**
   * An exported file's macrocycle for the stretch, in place of `dates`: the `fileGroup` and
   * `fileMacrocycleNum` that `mode=assign` gave it. `group` is an opaque token to send back as
   * given, not a program.
   */
  file?: { group: string; macrocycleNum: number };
  status: MacrocycleStatus;
  /** The lifter chose `status` (or the export's `Status` column did), so no rule may change it. */
  statusChosen: boolean;
}

/**
 * The lifter's confirmed Assign breakdown, sent as the `breakdown` field of a lift-records
 * `mode=dry-run` or `mode=commit` (#1254). Every dated session is in one stretch, in
 * `excludedDates` or in `nonCycleDates`. A file's `non-cycle` rows needn't be listed.
 */
export interface ImportBreakdown {
  stretches: ImportBreakdownStretch[];
  excludedDates: string[];
  nonCycleDates: string[];
}

/** A suggested macrocycle's status at the Assign step (proposal decisions 6 and 7). */
export type AssignStretchStatus = 'in-progress' | 'completed' | 'overran' | 'abandoned';

/** Why a stretch starts where it does: `segmentLiftHistory`'s `StretchStartReason`. */
export type AssignStartReason =
  | { kind: 'first-session' }
  | { kind: 'gap'; days: number }
  | { kind: 'previous-run-finished' }
  | { kind: 'program-column-changed'; from: string | null; to: string }
  | { kind: 'lift-outside-program'; lifts: string[] }
  | { kind: 'set-order-changed'; lifts: Array<{ lift: string; from: string; to: string }> }
  | { kind: 'previous-fits-no-program' }
  | { kind: 'workout-number-fell-back'; from: number; to: number }
  | { kind: 'file-macrocycle'; macrocycleNum: number };

/** Where a stretch's program came from: `segmentLiftHistory`'s `StretchProgramReason`. */
export type AssignProgramReason =
  | { kind: 'column'; value: string }
  | { kind: 'lifts'; tiedWith: string[]; bySetOrder: boolean }
  | { kind: 'source' };

/** Why a stretch has its suggested status: `segmentLiftHistory`'s `StretchStatusReason`. */
export type AssignStatusReason =
  | { kind: 'all-workouts-done' }
  | { kind: 'next-is-restart' }
  | { kind: 'next-is-different-program' }
  | { kind: 'next-is-unmatched' }
  | { kind: 'last-session-stale'; daysBeforeImport: number }
  | { kind: 'past-expected-length'; weeksSinceStart: number }
  | { kind: 'inside-expected-length'; weeksSinceStart: number }
  | { kind: 'open-ended' }
  | { kind: 'unmatched' };

/** One session (every row with one date) at the Assign step. Dates are `YYYY-MM-DD`. */
export interface AssignSession {
  date: string;
  /** The file's workout number, or the session's position in its stretch. */
  workoutNum: number | null;
  /** Display names of the session's lifts, in file order, each once. */
  lifts: string[];
  /** Rows (sets) in the session. */
  sets: number;
}

/** A contiguous run of sessions the rules group into one suggested macrocycle. */
export interface AssignStretch {
  program: string;
  /** False when the stretch's lifts fit no known program; it's then stored under `program`, flagged unmatched. */
  matched: boolean;
  /** Lifts outside `program` that the lifter is asked to confirm. */
  liftsOutsideProgram: string[];
  /** The program the stretch would be once its lifts are confirmed. */
  candidateProgram: string | null;
  /** The file's own macrocycle number, when it has them. */
  fileMacrocycleNum: number | null;
  /**
   * With `fileMacrocycleNum`, the program group the file's rows were put in, which an export's
   * breakdown sends back as `file.group` (#1256). Null when the file has no numbers.
   */
  fileGroup: string | null;
  startDate: string;
  endDate: string;
  sessions: AssignSession[];
  completedWorkouts: number;
  /** Null for a custom program, which is open-ended, or an unmatched stretch. */
  expectedWorkouts: number | null;
  /** Null when the rules can't suggest one, so the lifter must choose. */
  status: AssignStretchStatus | null;
  /**
   * An exported file's `Status` for the stretch's rows (#1254, decision 22): a status the lifter
   * chose, which the wizard sends back with `statusChosen`. Null when the file has none.
   */
  fileStatus: MacrocycleStatus | null;
  reasons: { start: AssignStartReason; program: AssignProgramReason; status: AssignStatusReason };
  /** How the stretch, as suggested, meets what's already stored (#1255, decision 14). */
  stored: AssignStoredPlacement;
}

/**
 * How a suggested stretch meets the stored macrocycles (#1255, proposal decision 14). The commit
 * places the confirmed breakdown by the same rule, so an edited boundary can change it.
 *
 * - `new`: it would form a macrocycle of its own.
 * - `already-imported`: every row is already stored, so it writes nothing.
 * - `joins`: its `newWorkouts` new sessions join stored macrocycle `macrocycleNum` of its program.
 * - `overlaps`: its dates overlap stored macrocycles it can't join, so it forms its own.
 */
export type AssignStoredPlacement =
  | { kind: 'new' }
  | { kind: 'already-imported' }
  | { kind: 'joins'; macrocycleNum: number; newWorkouts: number }
  | { kind: 'overlaps'; macrocycles: Array<{ program: string; macrocycleNum: number }> };

/** A single-lift session inside a break, for the lifter to file (proposal decision 5). */
export interface AssignLoneSession {
  session: AssignSession;
  daysAfterPrevious: number | null;
  daysBeforeNext: number | null;
}

/** A conflict between a file's macrocycle numbers and its dates (proposal decision 8). Indexes are into `stretches`. */
export type AssignConflict =
  | { kind: 'gap-inside-number'; stretch: number; from: string; to: string; days: number }
  | { kind: 'numbers-overlap'; stretches: [number, number] };

/** A program a stretch can be assigned to. */
export interface AssignProgramOption {
  id: string;
  /** A custom program's name. Null for a built-in, which the client names from its own catalog. */
  name: string | null;
  /** Workouts in one run; null for a custom program, which is open-ended. */
  workouts: number | null;
  weeks: number;
}

/**
 * Response for `POST /programs/:program/import?mode=assign` (#1253): the rules' grouping of a
 * lift-records file into suggested macrocycles, from its dates, after Review's exclusions and
 * lift overrides (proposal decision 16). Nothing is written.
 */
export interface ImportAssignResponse {
  /** The import date the statuses were judged against, `YYYY-MM-DD`. */
  importDate: string;
  /** Dated sessions, counting lone, non-cycle and unnumbered ones. */
  sessions: number;
  stretches: AssignStretch[];
  lone: AssignLoneSession[];
  /** Sessions whose `Program` is `non-cycle`, stored as non-cycle workouts. */
  nonCycle: AssignSession[];
  /** In a file with macrocycle numbers, sessions with no number to take, for the lifter to file. */
  unnumbered: AssignSession[];
  conflicts: AssignConflict[];
  /** Rows with no date: left out of the import and counted. */
  undatedRows: number;
  /** The file is this app's own export, so overlapping numbers don't block (decision 8). */
  exported: boolean;
  programs: AssignProgramOption[];
  /**
   * One-rep-max rows split to training maxes (decision 10), judged against the max of the
   * program covering each row's date. Present only when the request asks for the split.
   */
  split?: { changes: number; olderThanCurrent: number };
}

/** Phase 3: Response for `POST /programs/:program/import/:batchId/undo`. */
export interface ImportUndoResponse {
  batchId: string;
  /** Rows successfully restored to their pre-import state (or deleted if newly created). */
  restored: number;
  /** Rows skipped because they have been edited since the import (post-edit guard). */
  skipped: number;
  /** Detail on rows that were flagged (key + reason for each). */
  flagged: Array<{ key: string; reason: string }>;
}

/**
 * One import that touched a program's macrocycles, from `GET /programs/:program/import/batches`
 * (#1257), so the import can be undone after leaving the wizard. An import through the Assign
 * step that wrote to several programs is undone as a whole, through its Source program's batch:
 * `id` and `program` name that batch, whichever program's list it appears in.
 */
export interface ImportBatchSummary {
  /** The batch to undo: `POST /programs/{program}/import/{id}/undo`. */
  id: string;
  program: string;
  /** When the import was committed, as an ISO 8601 timestamp. */
  createdAt: string;
  /** The listed program's macrocycles the import created or added sets to, by id. */
  macrocycleIds: string[];
}

/** Request body for `POST /programs/:program/import/google-sheet` (#1111). */
export interface GoogleSheetImportRequest {
  /** A Google Sheets link (any tab) or a bare spreadsheet ID. */
  url: string;
}

/** One worksheet of a fetched Google Sheets workbook, classified for import. */
export interface GoogleSheetTab {
  /** Worksheet (tab) name as shown in Google Sheets. */
  name: string;
  /** Non-empty rows in the tab, including the header row. */
  rowCount: number;
  classification: ImportClassification;
  /**
   * The kind the tab is offered as: `classification.type` when the classifier
   * auto-accepted one, otherwise the top-scoring kind for a medium- or
   * high-confidence tab (the user confirms it, as in the CSV path's manual pick),
   * otherwise `null`.
   */
  suggestedKind: ImportKind | null;
  /**
   * The tab as CSV text, ready to send to the Smart Import preview/commit
   * endpoint as a file. `null` when the tab is not importable; `skipReason` says why.
   */
  csv: string | null;
  /** Why the tab can't be imported (unrecognized, or over a row, width or file-size cap); `null` when it can. */
  skipReason: string | null;
}

/** Response for `POST /programs/:program/import/google-sheet` (#1111). */
export interface GoogleSheetWorkbookResponse {
  tabs: GoogleSheetTab[];
}

// ---------------------------------------------------------------------------
// Custom Lifts
// ---------------------------------------------------------------------------

/** Serialized custom lift as returned by the API. `userId` is intentionally omitted. */
export interface CustomLiftResponse {
  id: string; // uuid — the REST key
  name: string;
  classification: LiftClassification;
  movementProfile: MovementProfile;
  isBodyweightComponent: boolean;
  isCustom: true;
  createdAt: string; // ISO 8601 date string
}

/** Request body for POST /lifts/custom. */
export interface CreateCustomLiftRequest {
  name: string;
  classification: LiftClassification;
  movementProfile?: MovementProfile;
  isBodyweightComponent?: boolean;
}

/** Request body for PATCH /lifts/custom/:id. All fields optional. */
export interface UpdateCustomLiftRequest {
  name?: string;
  classification?: LiftClassification;
  movementProfile?: MovementProfile;
  isBodyweightComponent?: boolean;
}

// ---------------------------------------------------------------------------
// Lift Modifications
// ---------------------------------------------------------------------------

/** Serialized lift modification as returned by the API. `userId` is intentionally omitted. */
export interface LiftModificationResponse {
  id: string; // uuid — the REST key
  /** The lift's id: a catalog id, or a custom lift's uuid. */
  lift: string;
  name: string;
  description: string;
  maxMode: LiftModificationMaxMode;
  createdAt: string; // ISO 8601 date string
}

/**
 * Response of GET /lifts/modifications/by-lift: each lift's modifications, keyed by the name it was
 * asked under, so two spellings of one lift each get the same entries (#1242).
 */
export type LiftModificationsByLiftResponse = Record<string, LiftModificationResponse[]>;

/**
 * A modification as a logged set names it. It carries the name so an archived modification is
 * still named on the sets that used it, though the list no longer shows it.
 */
export interface LiftModificationRef {
  id: string;
  name: string;
}

/** Request body for POST /lifts/modifications. */
export interface CreateLiftModificationRequest {
  /** The lift, under any name it resolves by, such as `Bench Press` or `bench-press`. */
  lift: LiftName;
  name: string;
  description?: string;
  maxMode?: LiftModificationMaxMode;
}

/** Request body for PATCH /lifts/modifications/:id. All fields optional. */
export interface UpdateLiftModificationRequest {
  name?: string;
  description?: string;
  maxMode?: LiftModificationMaxMode;
}

/**
 * A modification's own training max in one program (#1153), from
 * GET /programs/:program/modification-maxes. Only a modification whose `maxMode` is `own` has one.
 */
export interface ModificationMaxResponse {
  modificationId: string;
  weight: number;
  unit: WeightUnit;
  dateUpdated: string; // ISO 8601 date string
}

/** Request body for PUT /programs/:program/modification-maxes/:modificationId. */
export interface PutModificationMaxRequest {
  weight: number;
}
