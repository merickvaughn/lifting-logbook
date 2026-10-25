import type { MuscleGroup } from './domain';

/**
 * Focus work (#1053): user-configured accessory blocks that target one muscle area for a
 * calendar month or quarter (or one period from a custom start date), on a timeline
 * separate from the program, layered onto every workout. See
 * docs/proposals/2026-10-24-focus-work-accessory-blocks.md.
 */

/** The areas a focus block can target, in the order the setup page lists them. */
export const FOCUS_AREAS = [
  'Shoulders',
  'Biceps',
  'Triceps',
  'Back',
  'Chest',
  'Calves',
  'Glutes',
  'Core',
] as const;

export type FocusArea = (typeof FOCUS_AREAS)[number];

/**
 * The {@link MuscleGroup}s each focus area covers. A planned lift "trains the area" when
 * one of its primary muscles is in this list.
 */
export const FOCUS_AREA_MUSCLES: Readonly<Record<FocusArea, readonly MuscleGroup[]>> = {
  Shoulders: ['Front Delts', 'Side Delts', 'Rear Delts'],
  Biceps: ['Biceps'],
  Triceps: ['Triceps'],
  Back: ['Lats', 'Upper Back', 'Traps', 'Lower Back'],
  Chest: ['Chest'],
  Calves: ['Calves'],
  Glutes: ['Glutes'],
  Core: ['Core'],
};

/** How long a block runs. */
export const FOCUS_PERIODS = ['monthly', 'quarterly'] as const;
export type FocusPeriod = (typeof FOCUS_PERIODS)[number];

/**
 * `calendar` snaps the block to the calendar month or quarter containing `start`;
 * `custom` runs one period from `start` itself.
 */
export const FOCUS_ALIGNS = ['calendar', 'custom'] as const;
export type FocusAlign = (typeof FOCUS_ALIGNS)[number];

/**
 * How a block picks its lifts each workout:
 * - `rules` — every eligible pool lift;
 * - `rotate` — one lift per workout, cycling through the pool (Always lifts on top);
 * - `fixed` — the first eligible lift every workout;
 * - `pick` — eligible lifts are offered as suggestions and the user chooses.
 */
export const FOCUS_SELECTIONS = ['rules', 'rotate', 'fixed', 'pick'] as const;
export type FocusSelection = (typeof FOCUS_SELECTIONS)[number];

/**
 * What a block does when the day's planned lifts already train its area:
 * swap to complementary lifts, one set fewer per lift, skip, or do it anyway.
 */
export const FOCUS_OVERLAPS = ['swap', 'reduce', 'skip', 'anyway'] as const;
export type FocusOverlap = (typeof FOCUS_OVERLAPS)[number];

/** How a pool lift's sets are prescribed. */
export const FOCUS_PROGRESSIONS = ['double', 'fixed', 'tm', 'rpe'] as const;
export type FocusProgression = (typeof FOCUS_PROGRESSIONS)[number];

/** What happens when a block ends: prompt the user, or roll into `nextArea` automatically. */
export const FOCUS_ON_ENDS = ['prompt', 'autoroll'] as const;
export type FocusOnEnd = (typeof FOCUS_ON_ENDS)[number];

/**
 * When a pool lift is used:
 * - `auto` — follows the block's selection mode;
 * - `always` — added every workout, on top of the selection;
 * - `rule` — only when `ruleLift` is not planned that day;
 * - `swap` — only as another lift's overlap swap target;
 * - `off` — never.
 */
export const FOCUS_INCLUDES = ['auto', 'always', 'rule', 'swap', 'off'] as const;
export type FocusInclude = (typeof FOCUS_INCLUDES)[number];

/** Date-derived block status. Never stored. */
export type FocusBlockStatus = 'queued' | 'active' | 'ended';

/** A block's own timer, in seconds. */
export interface FocusTimer {
  prep: number;
  set: number;
  rest: number;
}

/** One lift in a block's pool, with its prescription inputs. */
export interface FocusPoolEntry {
  lift: string;
  include: FocusInclude;
  /** For `include: 'rule'`: skip this lift on days this lift is planned. */
  ruleLift: string;
  /** On overlap with `overlap: 'swap'`: the pool lift to do instead. Empty keeps this lift. */
  swapTo: string;
  sets: number;
  /** Bottom of the rep range (double progression). */
  repsLow: number;
  /** Top of the rep range; the rep target for the other progressions. */
  repsHigh: number;
  /** Working weight for double and fixed progression. Directly known: never rounded. */
  weight: number;
  /** Training max for `tm` progression. */
  trainingMax: number;
  /** Percent of `trainingMax` for `tm` progression (0–100). */
  percent: number;
  /** Target RPE for `rpe` progression. */
  rpe: number;
  /** Reps from the last session, shown as a double-progression hint. */
  lastReps?: readonly number[];
}

export interface FocusBlock {
  id: string;
  /** Blocks that roll into one another share a series. */
  series: string;
  area: FocusArea;
  period: FocusPeriod;
  align: FocusAlign;
  /** ISO date (YYYY-MM-DD). */
  start: string;
  selection: FocusSelection;
  overlap: FocusOverlap;
  progression: FocusProgression;
  /** 1 is the highest priority. */
  priority: number;
  timer: FocusTimer;
  onEnd: FocusOnEnd;
  /** The area an auto-roll successor targets. */
  nextArea: FocusArea | null;
  pool: FocusPoolEntry[];
}

/** The advisory daily focus guide. Going over suggests a trim; nothing is blocked. */
export interface FocusBudget {
  sets: number;
  minutes: number;
}

/** Where focus work sits relative to the planned lifts on a workout. */
export const FOCUS_PLACEMENTS = ['before', 'after', 'interleave'] as const;
export type FocusPlacement = (typeof FOCUS_PLACEMENTS)[number];

/** A user's per-workout adjustments to focus work. */
export interface FocusDayState {
  /** Selection mode overrides for this workout, by block id. */
  modes: Record<string, FocusSelection>;
  /** Lifts chosen in `pick` mode, by block id. */
  picks: Record<string, string[]>;
  /** Lifts trimmed for this workout, by block id. */
  trims: Record<string, string[]>;
  placement: FocusPlacement;
  /** Interleaved order of lift ids, when the user has reordered. */
  order: string[] | null;
  /** True when the user chose to keep everything despite being over the guide. */
  dismissed: boolean;
}

// ---------------------------------------------------------------------------
// API contracts (#1056)
// ---------------------------------------------------------------------------

/** The daily focus guide when the user has not set one, as in the prototype. */
export const DEFAULT_FOCUS_BUDGET: Readonly<FocusBudget> = { sets: 9, minutes: 20 };

/** The timer a new focus block starts with, as in the prototype. */
export const DEFAULT_FOCUS_TIMER: Readonly<FocusTimer> = { prep: 10, set: 45, rest: 60 };

/** Where focus work sits on a workout until the user moves it, as in the prototype. */
export const DEFAULT_FOCUS_PLACEMENT: FocusPlacement = 'after';

/**
 * A day state with no adjustments: what a workout reads as before anything is saved. A
 * fresh object on every call, so no caller can mutate another's.
 */
export function emptyFocusDayState(): FocusDayState {
  return { modes: {}, picks: {}, trims: {}, placement: DEFAULT_FOCUS_PLACEMENT, order: null, dismissed: false };
}

/** A focus block as the API returns it, with its derived status and date range. */
export interface FocusBlockResponse extends FocusBlock {
  /** Derived from the dates and the request's `today`; never stored. */
  status: FocusBlockStatus;
  /** First day of the block, inclusive (ISO date). */
  rangeStart: string;
  /** Last day of the block, inclusive (ISO date). */
  rangeEnd: string;
}

/**
 * Creates a focus block. `series` defaults to the new block's own id, starting a series of
 * its own; pass an existing series to queue a block after one that is running. `priority`
 * defaults to one below the current lowest-priority block.
 */
export interface CreateFocusBlockRequest {
  series?: string;
  area: FocusArea;
  period: FocusPeriod;
  align: FocusAlign;
  /** ISO date (YYYY-MM-DD). */
  start: string;
  selection: FocusSelection;
  overlap: FocusOverlap;
  progression: FocusProgression;
  priority?: number;
  timer: FocusTimer;
  onEnd: FocusOnEnd;
  nextArea: FocusArea | null;
  pool: FocusPoolEntry[];
}

/** Replaces any of a focus block's fields. `series` is fixed; `priority` changes by reorder. */
export type UpdateFocusBlockRequest = Partial<Omit<CreateFocusBlockRequest, 'series' | 'priority'>>;

/** Every focus block id, in priority order, highest first. */
export interface ReorderFocusBlocksRequest {
  ids: string[];
}

export type FocusSettingsResponse = FocusBudget;
export type UpdateFocusSettingsRequest = FocusBudget;

/** A focus lift's prescription. Mirrors core's `FocusPrescription`. */
export type FocusPrescriptionResponse =
  | {
      progression: 'double';
      sets: number;
      repsLow: number;
      repsHigh: number;
      weight: number;
      lastReps: readonly number[] | null;
    }
  | { progression: 'fixed'; sets: number; reps: number; weight: number }
  | { progression: 'tm'; sets: number; reps: number; weight: number; percent: number; trainingMax: number }
  | { progression: 'rpe'; sets: number; reps: number; rpe: number; repsInReserve: number };

export interface FocusPlanItemResponse {
  lift: string;
  sets: number;
  /** Set count before an overlap Reduce took one off. */
  reducedFrom?: number;
  /** The pool lift an overlap Swap replaced. */
  swappedFrom?: string;
  entry: FocusPoolEntry;
  prescription: FocusPrescriptionResponse;
}

export interface FocusPlanGroupResponse {
  block: FocusBlockResponse;
  /** The selection mode used today: the day's override, or the block's own. */
  mode: FocusSelection;
  items: FocusPlanItemResponse[];
  skipped: { lift: string; reason: 'rule' | 'rotation' | 'fixed' | 'overlap'; detail: string }[];
  /** In `pick` mode, the lifts offered to choose from. Empty otherwise. */
  suggestions: FocusPoolEntry[];
  overlap: { lifts: string[]; mode: FocusOverlap } | null;
  /** Lifts the user trimmed for this workout. */
  trimmed: string[];
}

/** One workout's focus work: the active focus blocks with the day's saved state applied. */
export interface FocusDayPlanResponse {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  /** The user's calendar day the plan was computed for (ISO date). */
  today: string;
  /** The workout's planned lifts after overrides, by name. */
  plannedLifts: string[];
  budget: FocusBudget;
  dayState: FocusDayState;
  groups: FocusPlanGroupResponse[];
  sets: number;
  seconds: number;
  /** Over the daily guide on sets or minutes. Advisory only. */
  over: boolean;
  suggestion: { blockId: string; lift: string; sets: number; seconds: number } | null;
}

/** Totals for a focus block from the user's logged lift records. */
export interface FocusBlockSummaryResponse {
  blockId: string;
  rangeStart: string;
  rangeEnd: string;
  /** Distinct days with at least one pool-lift set. */
  sessions: number;
  sets: number;
  /** Sum of weight × reps. */
  volume: number;
  prs: { lift: string; weight: number; reps: number; previousWeight: number; previousReps: number }[];
}
