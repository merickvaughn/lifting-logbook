import { FOCUS_AREA_MUSCLES, type FocusArea, type FocusPoolEntry } from '@lifting-logbook/types';
import { LIFT_CATALOG } from '../catalog/lifts';

/** How many lifts a new focus block's pool starts with. */
export const DEFAULT_FOCUS_POOL_SIZE = 3;

/** A pool entry with the prototype's starting prescription; the user edits it from there. */
export function defaultPoolEntry(lift: string): FocusPoolEntry {
  return {
    lift,
    include: 'auto',
    ruleLift: '',
    swapTo: '',
    sets: 3,
    repsLow: 10,
    repsHigh: 12,
    weight: 25,
    trainingMax: 40,
    percent: 65,
    rpe: 8,
  };
}

/**
 * The pool a new focus block for `area` starts with: the first catalog accessory lifts, in
 * catalog order, with a primary muscle in the area. Also the pool an auto-roll successor
 * gets, since a new area needs new lifts (`expandRollovers`' `poolFor`).
 */
export function defaultFocusPool(area: FocusArea): FocusPoolEntry[] {
  const groups: readonly string[] = FOCUS_AREA_MUSCLES[area];
  return LIFT_CATALOG.filter(
    (lift) => lift.classification === 'accessory' && lift.muscles.primary.some((m) => groups.includes(m)),
  )
    .slice(0, DEFAULT_FOCUS_POOL_SIZE)
    .map((lift) => defaultPoolEntry(lift.name));
}
