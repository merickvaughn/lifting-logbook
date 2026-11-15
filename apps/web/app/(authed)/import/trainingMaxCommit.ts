import type { ImportDelta } from '@lifting-logbook/types';

/**
 * A training max on the Review list. `date` is the file's Date Updated for the row,
 * `YYYY-MM-DD`; it is absent once the weight is edited, or from an API that doesn't send it,
 * and the row is then dated today.
 */
export type EditableMax = { lift: string; label: string; weight: string; date?: string };

// ImportDelta.key can repeat a natural key with a `#N` suffix, which identifies a row
// only in the wizard.
export function naturalKeyOf(delta: ImportDelta): string {
  return delta.key.replace(/#\d+$/, '');
}

type Row = { lift: string; weight: number; date: string };

/**
 * The rows of the training-max file the wizard commits: the Review list as edited, plus the file's rows
 * Review doesn't list, so the server counts each of them as skipped the way the preview did
 * (#1123, #1128). Each row keeps the file's date unless its weight was edited.
 *
 * A row Review doesn't list is the newest row of a lift the file leaves unchanged, or an older
 * row of a lift. An older row goes in only behind its lift's newest row, and takes that row's
 * date: the server keeps the most recent row of a lift and, between rows of one day, the first,
 * so the older row is always the skip. Without the newest row (removed, or its weight cleared)
 * the older row would be written instead, so it stays out too.
 */
export function trainingMaxCommitRows(
  reviewMaxes: readonly EditableMax[],
  deltas: readonly ImportDelta[],
  excludedKeys: ReadonlySet<string>,
  today: string,
): Row[] {
  // A cleared or zero weight isn't sent.
  const row = (lift: string, weight: string | undefined, date: string): Row[] =>
    Number(weight) > 0 ? [{ lift, weight: Number(weight), date }] : [];
  const newest: Row[] = [];
  const listed = new Set(reviewMaxes.map((r) => r.lift));
  for (const r of reviewMaxes) {
    if (!excludedKeys.has(r.lift)) newest.push(...row(r.lift, r.weight, r.date ?? today));
  }
  // A lift's first delta is its newest row, and the only one with a bare key.
  for (const d of deltas) {
    if (d.kind === 'skip' && d.key === naturalKeyOf(d) && !listed.has(d.key) && !excludedKeys.has(d.key)) {
      newest.push(...row(d.key, d.after, d.date ?? today));
    }
  }
  const dateOf = new Map(newest.map((r) => [r.lift, r.date]));
  const older: Row[] = [];
  for (const d of deltas) {
    const date = dateOf.get(naturalKeyOf(d));
    if (d.key !== naturalKeyOf(d) && date !== undefined && !excludedKeys.has(d.key)) {
      older.push(...row(naturalKeyOf(d), d.after, date));
    }
  }
  return [...newest, ...older];
}

/** The training-max file the wizard commits, from {@link trainingMaxCommitRows}. */
export function buildTrainingMaxesCsv(
  reviewMaxes: readonly EditableMax[],
  deltas: readonly ImportDelta[],
  excludedKeys: ReadonlySet<string>,
  today: string,
): string {
  const lines = trainingMaxCommitRows(reviewMaxes, deltas, excludedKeys, today).map(
    (r) => `${r.date},"${r.lift.replace(/"/g, '""')}",${r.weight}`,
  );
  return ['Date Updated,Lift,Weight', ...lines].join('\n');
}
