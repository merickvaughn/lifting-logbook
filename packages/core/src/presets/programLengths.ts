import { WeekNumber } from '@lifting-logbook/types';
import { addDaysUTC } from '../utils/jsUtil';

/**
 * How a program's weeks are periodized for plan display.
 *
 * - 'repeating': autoregulated / repeating-block programs (Leangains, RPT). Every
 *   week is a training week; progression is AMRAP-driven (via `updateMaxes` from
 *   actual lift records), not a fixed weekly bump. Rendered as a single flat
 *   "Training" span — never a fabricated deload/test week.
 * - 'wave': structured, periodized programs (5/3/1). The repeating block is a
 *   wave; the plan shows one training phase per wave.
 */
export type ProgramPhaseStyle = 'repeating' | 'wave';

export interface ProgramLengthMeta {
  /** Authoritative total program length in weeks — the single source of truth. */
  lengthWeeks: number;
  /** Size of the repeating block in {@link PRESET_BASE_SPECS} (its max `week`). */
  blockWeeks: number;
  /** Plan-display periodization style. */
  phaseStyle: ProgramPhaseStyle;
}

/**
 * Canonical program-length registry — the single source of truth for how long a
 * built-in program runs and how it is periodized. Both API schedule generation
 * (`cycle-generation.service.ts`) and web onboarding copy (`apps/web/lib/programs.ts`)
 * derive from this, replacing three previously-disagreeing sources: the onboarding
 * `weeks` literal, the 1-week preset block, and the `Math.max(...spec.week)`-derived
 * duration (which collapsed Leangains to "1 total week"). See issue #680.
 *
 * Keyed by the same program IDs as {@link PRESET_BASE_SPECS}. Programs without an
 * entry (custom user programs, not-yet-wired presets) fall back to their base-spec
 * block length via {@link programLengthWeeks}, preserving the historical
 * `Math.max(...spec.week)` behavior.
 *
 * KEEP IN SYNC: every {@link PRESET_BASE_SPECS} key must have an entry here — a
 * seeded (schedulable) program without a canonical length silently collapses to
 * its 1-block length. This is the third registry alongside PRESET_BASE_SPECS and
 * apps/api `PROGRAM_DEFAULTS`; the reciprocal guard lives in `programLengths.test.ts`.
 */
export const PROGRAM_LENGTHS: Record<string, ProgramLengthMeta> = {
  // 1-week repeating block tiled across 12 weeks; autoregulated (RPT + IF protocol).
  leangains: { lengthWeeks: 12, blockWeeks: 1, phaseStyle: 'repeating' },
  // 1-week repeating block tiled across 8 weeks; autoregulated (reverse-pyramid).
  rpt: { lengthWeeks: 8, blockWeeks: 1, phaseStyle: 'repeating' },
  // 3-week 5/3/1 wave tiled across 12 weeks (4 waves); structured / periodized.
  '5-3-1': { lengthWeeks: 12, blockWeeks: 3, phaseStyle: 'wave' },
};

/**
 * The size of a base spec's repeating block: the max `week` present in the rows
 * (0 for an empty spec). Reads `week` only, so it accepts both the domain
 * {@link LiftingProgramSpec} and its serialized `LiftingProgramSpecResponse`.
 */
export function baseSpecBlockWeeks(
  spec: ReadonlyArray<{ week: WeekNumber }>,
): number {
  return spec.reduce((max, s) => Math.max(max, s.week), 0);
}

/**
 * The authoritative program length in weeks. Prefers the canonical
 * {@link PROGRAM_LENGTHS} registry; falls back to the base-spec block size for
 * programs without an entry — this preserves the historical
 * `Math.max(...spec.week)` behavior for custom / unregistered programs.
 */
export function programLengthWeeks(
  program: string,
  spec: ReadonlyArray<{ week: WeekNumber }>,
): number {
  return PROGRAM_LENGTHS[program]?.lengthWeeks ?? baseSpecBlockWeeks(spec);
}

/**
 * Maps a program week (`1..lengthWeeks`) back to its week within the repeating
 * block. This is the inverse of {@link expandSpecToLength}'s tiling: the workouts
 * controller derives a tiled workout's planned lifts from its block week, so it
 * must pick the *same* block week `expandSpecToLength` tiled into that program
 * week — sharing this one function keeps the two in lockstep (issue #740).
 * `blockWeeks <= 0` (empty spec) returns the program week unchanged.
 */
export function blockWeekForProgramWeek(week: number, blockWeeks: number): number {
  return blockWeeks > 0 ? ((week - 1) % blockWeeks) + 1 : week;
}

/**
 * The spec rows that plan one workout day: the rows of the block week that program
 * `week` tiles from ({@link blockWeekForProgramWeek}) at day `offset`, in `order`.
 *
 * A workout carries its *program* week, but the stored spec — and the spec endpoint
 * serving it — is one untiled block. Matching a row's `week` against the program week
 * finds nothing from the second block on (Leangains/RPT week 2, 5-3-1 week 4), and
 * matching the week without the offset lists every day's lifts on every day (issue
 * #1014). The workouts controller (which lifts a day plans) and the web (each lift's
 * prescription) both resolve a day here, so they cannot disagree; and the result is
 * the Cycle Dashboard card's, which groups the tiled spec by the same `(week, offset)`
 * and sorts by the same `order`.
 *
 * `offset` is required: a caller without one has no day, and must decide what that
 * means rather than fall back to the whole week.
 */
export function specRowsForWorkoutDay<T extends { week: WeekNumber; offset: number; order: number }>(
  spec: readonly T[],
  week: number,
  offset: number,
): T[] {
  const blockWeek = blockWeekForProgramWeek(week, baseSpecBlockWeeks(spec));
  return spec
    .filter((row) => row.week === blockWeek && row.offset === offset)
    .sort((a, b) => a.order - b.order);
}

/**
 * Tiles a base spec (one repeating block) across `lengthWeeks` by repeating the
 * block's rows with incremented `week` numbers. Read-time expansion only — stored
 * specs are never mutated, so there is no DB migration and revert is a pure code
 * change (see issue #680). The block size is the max `week` present in `baseSpec`.
 *
 * Week numbering is contiguous `1..lengthWeeks`. A partial trailing block is
 * included: e.g. a 3-week block across 8 weeks yields weeks 1..8 with the final
 * block truncated at week 8 (weeks 7,8 = block weeks 1,2).
 *
 * Returns `[]` for an empty base spec (zero-spec guard) or `lengthWeeks <= 0`,
 * so callers computing `Math.max(...expanded.map(s => s.week))` must still guard
 * the empty case (`Math.max(...[])` is `-Infinity`).
 *
 * Generic over the row type so both the domain {@link LiftingProgramSpec} (API)
 * and its serialized `LiftingProgramSpecResponse` (web) can be tiled without a
 * cast — only the `week` field is read or rewritten.
 */
export function expandSpecToLength<T extends { week: WeekNumber }>(
  baseSpec: T[],
  lengthWeeks: number,
): T[] {
  const blockWeeks = baseSpecBlockWeeks(baseSpec);
  if (blockWeeks <= 0 || lengthWeeks <= 0) return [];

  // Group rows by their in-block week once, preserving each week's row order.
  const rowsByWeek = new Map<number, T[]>();
  for (const row of baseSpec) {
    const arr = rowsByWeek.get(row.week) ?? [];
    arr.push(row);
    rowsByWeek.set(row.week, arr);
  }

  const expanded: T[] = [];
  for (let week = 1; week <= lengthWeeks; week++) {
    const blockWeek = blockWeekForProgramWeek(week, blockWeeks);
    for (const row of rowsByWeek.get(blockWeek) ?? []) {
      expanded.push({ ...row, week });
    }
  }
  return expanded;
}

/**
 * The distinct `(week, offset)` workout-day keys of a spec, ordered by week then
 * offset. This is the canonical `workoutNum ↔ (week, offset)` mapping — the Nth
 * entry (1-based) is `workoutNum` N.
 *
 * Both the web Cycle Dashboard grid (`buildWorkoutDays`) and the API's no-schedule
 * `weekForWorkoutNum` fallback derive `workoutNum` from this single helper, so a
 * card's `workoutNum` and the workout it opens can never disagree. Callers pass a
 * spec already tiled to the canonical length via {@link expandSpecToLength}, so the
 * ordering spans the whole cycle rather than a single repeating block (issue #740).
 */
export function orderedWorkoutKeys(
  spec: ReadonlyArray<{ week: WeekNumber; offset: number }>,
): { week: WeekNumber; offset: number }[] {
  const seen = new Set<string>();
  const keys: { week: WeekNumber; offset: number }[] = [];
  for (const row of spec) {
    const key = `${row.week}:${row.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ week: row.week, offset: row.offset });
  }
  return keys.sort((a, b) => a.week - b.week || a.offset - b.offset);
}

/**
 * The UTC calendar date of a no-schedule workout day, from its `(week, offset)`
 * key relative to the cycle start: `cycleStart + (week-1)*7 + offset` days.
 * Program weeks are 7 calendar days (see `distributeWorkouts`), so a workout in
 * program week W at in-week `offset` lands `(W-1)*7 + offset` days after the
 * cycle start. Week 1 (`week === 1`) is just `cycleStart + offset`.
 *
 * The single source of truth for the spec-relative (no-schedule) workout date,
 * shared by the web Cycle Dashboard grid (`buildWorkoutDays`) and the API
 * no-schedule workout-detail fallback (`toWorkoutResponse`) so a card's date and
 * the detail page it opens can never drift (issue #745). This is the date-side
 * companion to {@link orderedWorkoutKeys}, which shares the `workoutNum ↔
 * (week, offset)` mapping the same two callers use (issue #740).
 */
export function noScheduleWorkoutDateUTC(
  cycleStart: Date,
  week: number,
  offset: number,
): Date {
  return addDaysUTC(cycleStart, (week - 1) * 7 + offset);
}
