/**
 * Display helpers for focus work on the workout details page (#1058).
 *
 * Pure functions, ported from the prototype's `focus-workout.jsx` (`fwRx`, the interleave
 * order, `fwPlannedSec`), so the component stays about rendering and each rule is tested
 * on its own. See docs/proposals/2026-10-24-focus-work-accessory-blocks.md.
 */
import { formatWeight, STANDARD_DURATIONS } from '@lifting-logbook/core';
import type {
  FocusOverlap,
  FocusPlanGroupResponse,
  FocusPlanItemResponse,
  FocusPrescriptionResponse,
  FocusProgression,
  FocusSelection,
  FocusTimer,
  WeightUnit,
} from '@lifting-logbook/types';
import type { PlannedSet } from './workoutPlan';

export const FOCUS_SELECTION_LABEL: Record<FocusSelection, string> = {
  rules: 'Rules',
  rotate: 'Rotate',
  fixed: 'Fixed',
  pick: 'I pick',
};

export const FOCUS_PROGRESSION_LABEL: Record<FocusProgression, string> = {
  double: 'Double progression',
  fixed: 'Fixed',
  tm: '% of TM',
  rpe: 'RPE',
};

/** Completes "Squat trains glutes today, so …". */
export const FOCUS_OVERLAP_DESCRIPTION: Record<FocusOverlap, string> = {
  swap: 'swapped to complementary lifts',
  reduce: 'one set fewer per lift',
  skip: 'focus work skipped today',
  anyway: 'doing the full prescription anyway',
};

/** How a focus lift's sets read: the collapsed summary, each set's spec, and a hint. */
export interface FocusPrescriptionText {
  summary: string;
  perSet: string;
  hint: string;
}

export function describePrescription(rx: FocusPrescriptionResponse, unit: WeightUnit): FocusPrescriptionText {
  switch (rx.progression) {
    case 'double': {
      const reps = rx.repsLow === rx.repsHigh ? String(rx.repsHigh) : `${rx.repsLow}–${rx.repsHigh}`;
      const last = rx.lastReps && rx.lastReps.length > 0 ? `Last time: ${rx.lastReps.join(', ')}. ` : '';
      return {
        summary: `${rx.sets} × ${reps}`,
        perSet: `${reps} reps @ ${formatWeight(rx.weight, 'lbs', unit)}`,
        hint: `${last}Hit ${rx.repsHigh} on every set and the weight goes up next time.`,
      };
    }
    case 'fixed':
      return {
        summary: `${rx.sets} × ${rx.reps}`,
        perSet: `${rx.reps} reps @ ${formatWeight(rx.weight, 'lbs', unit)}`,
        hint: 'Fixed prescription. You set the weight.',
      };
    case 'tm':
      return {
        summary: `${rx.sets} × ${rx.reps} @ ${rx.percent}%`,
        perSet: `${rx.reps} reps @ ${formatWeight(rx.weight, 'lbs', unit)}`,
        hint: `${rx.percent}% of a ${formatWeight(rx.trainingMax, 'lbs', unit)} training max.`,
      };
    case 'rpe':
      return {
        summary: `${rx.sets} × ${rx.reps} @ RPE ${rx.rpe}`,
        perSet: `${rx.reps} reps @ RPE ${rx.rpe}`,
        hint: `Pick a weight that leaves about ${rx.repsInReserve} rep${rx.repsInReserve === 1 ? '' : 's'} in reserve.`,
      };
    default: {
      const unknown: never = rx;
      throw new Error(`Unknown focus progression: ${JSON.stringify(unknown)}`);
    }
  }
}

/** `m:ss`, as the timer shows durations. */
export function formatClock(seconds: number): string {
  const n = Math.abs(Math.round(seconds));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export function timerHint(timer: FocusTimer): string {
  return `Timer: ${formatClock(timer.prep)} setup · ${formatClock(timer.set)} set · ${formatClock(timer.rest)} rest.`;
}

/** Whole minutes, as the summary grid and the guide compare them. */
export function toMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/**
 * Estimated seconds for the planned lifts on the Standard timer preset: each set's prep,
 * the set, and the rest after it. An estimate for the summary grid, not the timer's own
 * queue, which reads the lifter's settings.
 */
export function plannedSeconds(sets: readonly Pick<PlannedSet, 'type'>[]): number {
  const d = STANDARD_DURATIONS;
  return sets.reduce(
    (total, set) => total + d.prep + (set.type === 'warmup' ? d.warmupSet + d.restWarmup : d.workSet + d.restWork),
    0,
  );
}

/** Why a pool lift is not on today's list, completing "<lift> skipped: …". */
export function skipReason(skip: FocusPlanGroupResponse['skipped'][number], area: string): string {
  switch (skip.reason) {
    case 'rule':
      return `your rule: ${skip.detail} is planned`;
    case 'rotation':
      return 'rotation, up on another day';
    case 'fixed':
      return `fixed mode uses ${skip.detail}`;
    case 'overlap':
      return `${skip.detail} already trains ${area.toLowerCase()}`;
    default: {
      const unknown: never = skip.reason;
      throw new Error(`Unknown focus skip reason: ${String(unknown)}`);
    }
  }
}

/** The reduced or swapped note under a focus lift, or null when it runs as planned. */
export function overlapNote(item: FocusPlanItemResponse, group: FocusPlanGroupResponse): string | null {
  if (!group.overlap) return null;
  const why = `${group.overlap.lifts.join(' & ')} trains ${group.block.area.toLowerCase()} today`;
  if (item.reducedFrom !== undefined) return `Reduced ${item.reducedFrom} → ${item.sets} sets: ${why}`;
  if (item.swappedFrom !== undefined) return `Swapped from ${item.swappedFrom}: ${why}`;
  return null;
}

// ---------------------------------------------------------------------------
// Row ids and the interleaved order
// ---------------------------------------------------------------------------

/** FNV-1a (32-bit) as 8 hex digits: a short, stable stand-in for a lift name in an id. */
function nameHash(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * `<prefix><hash>#<n>` per lift, where `n` counts earlier occurrences of the same lift.
 * Named rather than positional, so a saved order survives a lift being added or removed
 * elsewhere in the workout. Counted, so the same lift twice still gets two ids (#971).
 * Hashed, so an id stays well inside the API's 100-character limit on `order` entries
 * however long the lift's name is.
 */
function occurrenceIds(prefix: string, lifts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return lifts.map((lift) => {
    const n = seen.get(lift) ?? 0;
    seen.set(lift, n + 1);
    return `${prefix}${nameHash(lift)}#${n}`;
  });
}

/** Persisted ids for the planned lifts, in plan order. */
export function plannedRowIds(lifts: readonly string[]): string[] {
  return occurrenceIds('p:', lifts);
}

/** Persisted ids for one focus block's lifts today, in its order. */
export function focusRowIds(blockId: string, lifts: readonly string[]): string[] {
  return occurrenceIds(`f:${blockId}:`, lifts);
}

/**
 * The interleaved list. With a saved order, its ids that still exist come first, in that
 * order, and anything new is appended. Without one, a focus lift follows each planned lift
 * until either runs out.
 */
export function interleavedOrder(
  planned: readonly string[],
  focus: readonly string[],
  saved: readonly string[] | null,
): string[] {
  if (saved) {
    const present = new Set([...planned, ...focus]);
    const kept = saved.filter((id, index) => present.has(id) && saved.indexOf(id) === index);
    const keptSet = new Set(kept);
    return [...kept, ...[...planned, ...focus].filter((id) => !keptSet.has(id))];
  }
  const out: string[] = [];
  let next = 0;
  for (const id of planned) {
    out.push(id);
    const f = focus[next];
    if (f !== undefined) {
      out.push(f);
      next++;
    }
  }
  return [...out, ...focus.slice(next)];
}

/** `order` with the id at `from` moved to `to`. Out-of-range moves return it unchanged. */
export function moveRow(order: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= order.length || to < 0 || to >= order.length || from === to) return [...order];
  const next = [...order];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
