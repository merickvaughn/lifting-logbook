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
export type FocusPeriod = 'monthly' | 'quarterly';

/**
 * `calendar` snaps the block to the calendar month or quarter containing `start`;
 * `custom` runs one period from `start` itself.
 */
export type FocusAlign = 'calendar' | 'custom';

/**
 * How a block picks its lifts each workout:
 * - `rules` — every eligible pool lift;
 * - `rotate` — one lift per workout, cycling through the pool (Always lifts on top);
 * - `fixed` — the first eligible lift every workout;
 * - `pick` — eligible lifts are offered as suggestions and the user chooses.
 */
export type FocusSelection = 'rules' | 'rotate' | 'fixed' | 'pick';

/**
 * What a block does when the day's planned lifts already train its area:
 * swap to complementary lifts, one set fewer per lift, skip, or do it anyway.
 */
export type FocusOverlap = 'swap' | 'reduce' | 'skip' | 'anyway';

/** How a pool lift's sets are prescribed. */
export type FocusProgression = 'double' | 'fixed' | 'tm' | 'rpe';

/** What happens when a block ends: prompt the user, or roll into `nextArea` automatically. */
export type FocusOnEnd = 'prompt' | 'autoroll';

/**
 * When a pool lift is used:
 * - `auto` — follows the block's selection mode;
 * - `always` — added every workout, on top of the selection;
 * - `rule` — only when `ruleLift` is not planned that day;
 * - `swap` — only as another lift's overlap swap target;
 * - `off` — never.
 */
export type FocusInclude = 'auto' | 'always' | 'rule' | 'swap' | 'off';

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
export type FocusPlacement = 'before' | 'after' | 'interleave';

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
