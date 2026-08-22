import { BodyWeightEntry, LiftClassification, LiftName, MovementProfile, WeightUnit, WeekNumber, CycleNumber, WeekType } from './domain';

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
}

/** Response from POST /training-maxes/recalculate. */
export interface RecalculateMaxesResponse {
  maxes: TrainingMaxResponse[];
  /** Lifts whose computed new TM would be lower than the current TM — not auto-applied. */
  flagged: MaxReductionFlagResponse[];
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
  setNum: number;
  weight: number;
  reps: number;
  amrap: boolean;
}

/** A single lift's sets within a workout. */
export interface WorkoutLiftResponse {
  lift: LiftName;
  sets: SetResponse[];
  /** True when derived from the program spec with no logged sets yet; false when backed by real records. */
  planned: boolean;
}

/** Serialized workout as returned by the API. */
export interface WorkoutResponse {
  program: string;
  cycleNum: CycleNumber;
  workoutNum: number;
  week: WeekNumber;
  date: string; // ISO 8601 date string
  overrideDate?: string; // ISO 8601 date string; present when the user has rescheduled
  skipped: boolean;
  lifts: WorkoutLiftResponse[];
  bodyWeightEntry?: Pick<BodyWeightEntry, 'weight' | 'unit'>;
}

/**
 * Request body for PATCH
 * /programs/:program/cycles/:cycleNum/workouts/:workoutNum/reschedule.
 *
 * Shared contract for the reschedule request shape: the backend `RescheduleDto`
 * (`apps/api`) implements this interface and the api-client builds its request
 * body as this type, so the two cannot drift. The endpoint returns 204 No
 * Content, so there is no corresponding response type — the reschedule result is
 * surfaced on the read side via `WorkoutResponse.overrideDate` and
 * `CycleDashboardResponse.dateOverrides`.
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
  cycleNum: CycleNumber;
  workoutNum: number;
  date: string; // ISO 8601 date string
  lift: LiftName;
  setNum: number;
  weight: number;
  reps: number;
  notes: string;
}

/** Request body for logging a new lift record. */
export interface CreateLiftRecordRequest {
  program: string;
  cycleNum: CycleNumber;
  workoutNum: number;
  /** Bare calendar date ("YYYY-MM-DD", no time/offset — see CreateLiftRecordDto.date in apps/api). When omitted the server uses the scheduled date for this workout, falling back to today. */
  date?: string;
  lift: LiftName;
  setNum: number;
  weight: number;
  reps: number;
  notes?: string;
}

/** Request body for updating an existing lift record (in-session editing). */
export interface UpdateLiftRecordRequest {
  weight?: number;
  reps?: number;
  notes?: string;
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
// Cycle Dashboard
// ---------------------------------------------------------------------------

/** Per-workout entry within a cycle week summary. */
export interface WorkoutSummary {
  workoutNum: number;
  date: string; // ISO 8601 scheduled date
  skipped: boolean;
}

/** Per-week summary within a cycle dashboard. */
export interface CycleWeekSummary {
  week: WeekNumber;
  workouts: WorkoutSummary[];
  completed: boolean;
}

/** Serialized cycle dashboard as returned by the API. */
export interface CycleDashboardResponse {
  program: string;
  cycleNum: CycleNumber;
  cycleStartDate: string; // ISO 8601 date string
  weeks: CycleWeekSummary[];
  currentWeekType: WeekType;
  /**
   * Per-workout metadata for the *whole* cycle, in both schedule and no-schedule
   * modes — `weeks` is empty in no-schedule mode, so the Cycle Dashboard reads
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
  /** `workoutNum`s explicitly skipped in this cycle. */
  skippedWorkoutNums: number[];
  /** `workoutNum`s with at least one logged lift record in this cycle. */
  completedWorkoutNums: number[];
}

// ---------------------------------------------------------------------------
// Cycle Planning Agent
// ---------------------------------------------------------------------------

/** A single proposed training-max change within a cycle plan. */
export interface ProposedTrainingMaxChangeResponse {
  lift: LiftName;
  currentWeight: number;
  proposedWeight: number;
  reasoning: string;
}

/** Result of a cycle planning agent run. */
export interface CyclePlanResponse {
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

/** Request body for POST /programs/:program/cycles/:cycleNum/workouts/:workoutNum/lift-overrides. */
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
}

/** Request body for PATCH /lifts/:lift/metadata. */
export interface PatchLiftMetadataRequest {
  muscleGroups?: string[];
  substitutions?: string[];
  foundational?: boolean;
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
}

export interface UpdateUserSettingsRequest {
  workoutSchedule?: UserWorkoutSchedule | null;
  defaultWeightIncrement?: number | null;
  unit?: WeightUnit | null;
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
  cycleNum: number;
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
  | 'CYCLE_NUM_INVALID'
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
  | 'UPLOAD_FAILED';

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
   * `"<cycleNum>:<workoutNum>:<YYYYMMDD>:<lift>:<setNum>"`
   *
   * All components use the canonical (post-import, post-slot-map) values. `date`
   * is part of the key (issue #884): two sets can otherwise legitimately share
   * the same (cycleNum, workoutNum, lift, setNum) tuple on different real
   * calendar dates and must not be treated as duplicates of each other.
   * Example: `"3:2:20260817:bench-press:1"` means cycle 3, workout 2,
   * 2026-08-17, bench-press, set 1.
   */
  naturalKey: string;
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

/** Row-level status for the interactive REVIEW step (Phase 3). */
export type ImportRowStatus = 'ok' | 'incomplete' | 'ambiguous';

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
  /** Phase 3: 1-based CSV data-row index (used by liftOverrides on commit). */
  rowIndex?: number;
  /** Phase 3: original unresolved lift name, populated on 'ambiguous' rows. */
  originalLift?: string;
}

/** Aggregate counts plus per-row deltas for a previewed import. */
export interface ImportPreview {
  creates: number;
  updates: number;
  skips: number;
  deltas: ImportDelta[];
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
