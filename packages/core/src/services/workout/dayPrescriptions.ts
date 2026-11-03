import type { LiftOverride } from '../../models/LiftOverride';
import { AppliedLiftOverrides, PlannedLift, applyLiftOverrides } from './applyLiftOverrides';

/** A spec row, or anything shaped like one: it names the lift it prescribes. */
interface LiftRow {
  lift: string;
}

/** Each name's occurrence among `names`, from 0, index-aligned with them. */
function nthOccurrences(names: readonly string[]): number[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return n;
  });
}

/**
 * Which occurrence of its lift each entry of a workout's lift list is, from 0,
 * index-aligned with `lifts`. A program can plan one lift twice in a day, and each
 * occurrence logs its own sets: a lift record's `occurrence` is this number (#1027).
 */
export function liftOccurrences(lifts: readonly { lift: string }[]): number[] {
  return nthOccurrences(lifts.map(({ lift }) => lift));
}

/**
 * The spec row prescribing each of a workout day's lifts, index-aligned with `lifts`:
 * a lift's own row, or for a Manage Lifts replacement the row of the slot it `replaces`,
 * whose prescription it inherits (the caller prices it from the replacement's own
 * training max). `undefined` where the day plans none: a lift logged ad hoc, or one
 * added through Manage Lifts or swapped into an added lift's slot (#1026).
 *
 * Where the day plans a lift more than once, the slots match its rows in order: the
 * second slot of a lift takes the lift's second row (#1027).
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
  const rowsByLift = new Map<string, Row[]>();
  for (const row of dayRows) {
    const rows = rowsByLift.get(row.lift);
    if (rows) rows.push(row);
    else rowsByLift.set(row.lift, [row]);
  }
  // A swap changes the movement, not the slot, so a replacement takes its slot's row (#1014).
  const slots = lifts.map(({ lift, replaces }) => replaces ?? lift);
  const nth = nthOccurrences(slots);
  return slots.map((slot, i) => rowsByLift.get(slot)?.[nth[i] ?? 0]);
}

/** A workout day's overrides applied, and the spec row each stored lift name takes. */
export interface DayPrescriptions<Row> extends AppliedLiftOverrides {
  /**
   * Stored lift name → its row on this day, for progression. Each planned lift takes
   * its row by the page rule ({@link plannedLiftRows}); a lift planned more than once
   * takes its first occurrence's row, the only occurrence that progresses it (#1027).
   * Two more rules apply only here, because only progression sees sets stored under
   * names the plan no longer shows:
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
 * day's spec lifts, a lift the day plans twice listed twice (#1027), and maps each
 * stored lift name to the row that prescribes it. The workout endpoint plans a day's
 * lifts with it and `updateMaxes` progresses a day's sets with it, so the two cannot
 * follow different rules for one swap (#1014, #1028).
 *
 * `overrides` must arrive in the order each was last written, as for
 * `applyLiftOverrides`.
 */
export function resolveDayPrescriptions<Row extends LiftRow>(
  dayRows: readonly Row[],
  overrides: readonly LiftOverride[],
): DayPrescriptions<Row> {
  const applied = applyLiftOverrides(
    dayRows.map(({ lift }) => lift),
    overrides,
  );

  const rowByStoredLift = new Map<string, Row>();
  const plannedRows = plannedLiftRows(dayRows, applied.planned);
  applied.planned.forEach(({ lift }, i) => {
    const row = plannedRows[i];
    if (row && !rowByStoredLift.has(lift)) rowByStoredLift.set(lift, row);
  });
  for (const [stored, current] of applied.renamed) {
    const row = rowByStoredLift.get(current);
    if (row && !rowByStoredLift.has(stored)) rowByStoredLift.set(stored, row);
  }
  for (const row of dayRows) if (!rowByStoredLift.has(row.lift)) rowByStoredLift.set(row.lift, row);

  return { ...applied, rowByStoredLift };
}
