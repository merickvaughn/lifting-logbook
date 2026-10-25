import {
  DEFAULT_FOCUS_PLACEMENT,
  DEFAULT_FOCUS_TIMER,
  FOCUS_INCLUDES,
  FOCUS_PLACEMENTS,
  FOCUS_SELECTIONS,
  FocusDayState,
  FocusPoolEntry,
  FocusSelection,
  FocusTimer,
  emptyFocusDayState,
} from '@lifting-logbook/types';

// Runtime guards for the focus JSON columns. Prisma returns whatever JSON is stored, and a
// manual edit or an older row could violate the type, so reads check the shape the DTOs
// enforce on write — the same reasoning as user-settings' parseSchedule.

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

export function parseFocusTimer(value: unknown): FocusTimer {
  if (isObject(value) && isCount(value.prep) && isCount(value.set) && isCount(value.rest)) {
    return { prep: value.prep, set: value.set, rest: value.rest };
  }
  return { ...DEFAULT_FOCUS_TIMER };
}

function parsePoolEntry(value: unknown): FocusPoolEntry | null {
  if (!isObject(value)) return null;
  const { lift, include, ruleLift, swapTo, sets, repsLow, repsHigh, weight, trainingMax, percent, rpe, lastReps } =
    value;
  if (typeof lift !== 'string' || !isOneOf(FOCUS_INCLUDES, include)) return null;
  if (typeof ruleLift !== 'string' || typeof swapTo !== 'string') return null;
  const numbers = [sets, repsLow, repsHigh, weight, trainingMax, percent, rpe];
  if (!numbers.every(isCount)) return null;
  const entry: FocusPoolEntry = {
    lift,
    include,
    ruleLift,
    swapTo,
    sets: sets as number,
    repsLow: repsLow as number,
    repsHigh: repsHigh as number,
    weight: weight as number,
    trainingMax: trainingMax as number,
    percent: percent as number,
    rpe: rpe as number,
  };
  if (Array.isArray(lastReps) && lastReps.every(isCount)) entry.lastReps = lastReps;
  return entry;
}

/** A stored pool, keeping only the entries that still read as pool entries. */
export function parseFocusPool(value: unknown): FocusPoolEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = parsePoolEntry(item);
    return entry ? [entry] : [];
  });
}

/** `Record<string, T>` entries that pass `keep`; anything else is dropped. */
function parseRecord<T>(value: unknown, keep: (item: unknown) => item is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (keep(item)) out[key] = item;
  }
  return out;
}

/**
 * A stored day state, field by field: an unreadable field falls back to its empty value
 * without discarding the rest, so a retired placement value keeps the user's trims and picks.
 */
export function parseFocusDayState(value: unknown): FocusDayState {
  if (!isObject(value)) return emptyFocusDayState();
  return {
    modes: parseRecord(value.modes, (item): item is FocusSelection => isOneOf(FOCUS_SELECTIONS, item)),
    picks: parseRecord(value.picks, isStringArray),
    trims: parseRecord(value.trims, isStringArray),
    placement: isOneOf(FOCUS_PLACEMENTS, value.placement) ? value.placement : DEFAULT_FOCUS_PLACEMENT,
    order: isStringArray(value.order) ? value.order : null,
    dismissed: value.dismissed === true,
  };
}
