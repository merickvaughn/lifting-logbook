import type { LiftOverride } from '../../models/LiftOverride';
import { AppliedLiftOverrides, PlannedLift, applyLiftOverrides } from './applyLiftOverrides';

/** A spec row, or anything shaped like one: it names the lift it prescribes. */
interface LiftRow {
  lift: string;
}

/** The day's rows by lift; where the day repeats a lift, its first row (#1027). */
function rowsBySlot<Row extends LiftRow>(dayRows: readonly Row[]): Map<string, Row> {
  const bySlot = new Map<string, Row>();
  for (const row of dayRows) if (!bySlot.has(row.lift)) bySlot.set(row.lift, row);
  return bySlot;
}

/**
 * The spec row prescribing each of a workout day's lifts, index-aligned with `lifts`:
 * a lift's own row, or for a Manage Lifts replacement the row of the slot it `replaces`,
 * whose prescription it inherits (the caller prices it from the replacement's own
 * training max). `undefined` where the day plans none: a lift logged ad hoc, or one
 * added through Manage Lifts or swapped into an added lift's slot (#1026).
 *
 * This is the page rule. The workout pages resolve a lift with it from the response's
 * `replaces`, and {@link resolveDayPrescriptions} resolves each planned lift with it, so
 * a change here reaches progression too. `dayRows` are the day's own spec rows
 * (`specRowsForWorkoutDay`).
 */
export function plannedLiftRows<Row extends LiftRow>(
  dayRows: readonly Row[],
  lifts: readonly PlannedLift[],
): (Row | undefined)[] {
  const bySlot = rowsBySlot(dayRows);
  // A swap changes the movement, not the slot, so a replacement takes its slot's row (#1014).
  return lifts.map(({ lift, replaces }) => bySlot.get(replaces ?? lift));
}

/** A workout day's overrides applied, and the spec row each stored lift name takes. */
export interface DayPrescriptions<Row> extends AppliedLiftOverrides {
  /**
   * Stored lift name → its row on this day, for progression. Each planned lift takes
   * its row by the page rule ({@link plannedLiftRows}). Two more rules apply only here,
   * because only progression sees sets stored under names the plan no longer shows:
   *
   * - sets under a slot's earlier name (a key of `renamed`) take the slot's row;
   * - a spec lift the plan no longer shows, such as a removed one, keeps its own row.
   *
   * A name the day prescribes nothing for is absent.
   */
  rowByStoredLift: Map<string, Row>;
}

/**
 * Resolves a workout day's prescriptions: applies the workout's lift overrides to the
 * day's spec lifts, each listed once even when the day repeats one (#1027), and maps
 * each stored lift name to the row that prescribes it. The workout endpoint plans a
 * day's lifts with it and `updateMaxes` progresses a day's sets with it, so the two
 * cannot follow different rules for one swap (#1014, #1028).
 *
 * `overrides` must arrive in the order each was last written, as for
 * `applyLiftOverrides`.
 */
export function resolveDayPrescriptions<Row extends LiftRow>(
  dayRows: readonly Row[],
  overrides: readonly LiftOverride[],
): DayPrescriptions<Row> {
  const bySlot = rowsBySlot(dayRows);
  const applied = applyLiftOverrides([...bySlot.keys()], overrides);

  const rowByStoredLift = new Map<string, Row>();
  const plannedRows = plannedLiftRows(dayRows, applied.planned);
  applied.planned.forEach(({ lift }, i) => {
    const row = plannedRows[i];
    if (row) rowByStoredLift.set(lift, row);
  });
  for (const [stored, current] of applied.renamed) {
    const row = rowByStoredLift.get(current);
    if (row && !rowByStoredLift.has(stored)) rowByStoredLift.set(stored, row);
  }
  for (const [lift, row] of bySlot) if (!rowByStoredLift.has(lift)) rowByStoredLift.set(lift, row);

  return { ...applied, rowByStoredLift };
}
