import type { LiftOverride } from '../../models/LiftOverride';

/** One entry of a workout's planned lift list, once its overrides are applied. */
export interface PlannedLift {
  lift: string;
  /**
   * The lift whose slot a `replace` put this one in, followed back through a
   * chain of swaps to the lift the slot started with — for a spec lift, the name
   * its prescription is stored under, which the replacement inherits (issue
   * #1014). Absent for a lift in its own slot, including one swapped back to it,
   * and for an `add`.
   */
  replaces?: string;
}

/** A workout's overrides, resolved once for both its plan and its logged sets. */
export interface AppliedLiftOverrides {
  /** The planned lifts, in order. */
  planned: PlannedLift[];
  /**
   * Stored lift name → the lift its logged sets are grouped under now. A swap
   * changes the movement, not the slot, so sets logged under any earlier name of
   * a slot — its spec lift, or a replacement it has since been swapped away
   * from — stay with the slot's current lift.
   */
  renamed: Map<string, string>;
  /** Stored lift names whose logged sets are hidden: a removed lift, and every earlier name of a removed slot. */
  removed: Set<string>;
}

/**
 * Applies a workout's lift overrides to its spec-derived lift list, and resolves
 * in the same pass where each stored lift name's logged sets now belong — so the
 * plan and the logged sets cannot follow different rules for one swap (#1014).
 *
 * - `remove`: drops the lift. Its logged sets are hidden, along with those of
 *   every earlier name its slot held; so are an unplanned (ad hoc) lift's.
 * - `replace`: swaps the lift in place, keeping its position. The replacement
 *   keeps the slot (`replaces`) and the slot's logged sets. Replacing an
 *   unplanned (ad hoc) lift regroups its logged sets under the replacement.
 * - `add`: appends the lift if it is not already planned.
 *
 * A lift the plan shows always owns the sets stored under its own name, even a
 * name an earlier override hid or regrouped: a set just logged against it must
 * not vanish. (Sets are keyed by name alone, so older sets under that name come
 * with it; telling them apart needs slot identity, #1027.)
 *
 * Overrides must arrive in the order each was last written — the repositories
 * guarantee it — because a chain depends on it: Squat → Front Squat → Box Squat
 * applies its second swap only after the first has put Front Squat in the list,
 * and a swap made again after being undone must apply after the undo.
 */
export function applyLiftOverrides(
  specLifts: readonly string[],
  overrides: readonly LiftOverride[],
): AppliedLiftOverrides {
  let planned: PlannedLift[] = specLifts.map((lift) => ({ lift }));
  // Every stored name an override has touched → the lift its sets belong to now
  // (null once removed). A name no override touched keeps its own sets.
  const owner = new Map<string, string | null>();
  const reassign = (from: string, to: string | null) => {
    for (const [name, current] of owner) {
      if (current === from) owner.set(name, to);
    }
    owner.set(from, to);
  };

  for (const o of overrides) {
    if (o.action === 'remove') {
      planned = planned.filter((l) => l.lift !== o.lift);
      reassign(o.lift, null);
    } else if (o.action === 'replace' && o.replacedBy) {
      const replacedBy = o.replacedBy;
      planned = planned.map((l) => {
        if (l.lift !== o.lift) return l;
        const slot = l.replaces ?? l.lift;
        return slot === replacedBy ? { lift: replacedBy } : { lift: replacedBy, replaces: slot };
      });
      reassign(o.lift, replacedBy);
    } else if (o.action === 'add') {
      if (!planned.some((l) => l.lift === o.lift)) planned.push({ lift: o.lift });
    }
  }

  for (const { lift } of planned) owner.delete(lift);

  const renamed = new Map<string, string>();
  const removed = new Set<string>();
  for (const [name, current] of owner) {
    if (current === null) removed.add(name);
    else if (current !== name) renamed.set(name, current);
  }
  return { planned, renamed, removed };
}
