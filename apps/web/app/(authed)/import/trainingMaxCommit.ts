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

type Row = { lift: string; weight: string; date: string };

/**
 * The training-max file the wizard commits: the Review list as edited, plus the file's rows
 * Review doesn't list, so the server counts each of them as skipped the way the preview did
 * (#1123, #1128). Each row keeps the file's date unless its weight was edited.
 *
 * A row Review doesn't list is the newest row of a lift the file leaves unchanged, or an older
 * row of a lift. An older row goes in only behind its lift's newest row, and takes that row's
 * date: the server keeps the most recent row of a lift and, between rows of one day, the first,
 * so the older row is always the skip. Without the newest row (removed, or its weight cleared)
 * the older row would be written instead, so it stays out too.
 */
export function buildTrainingMaxesCsv(
  reviewMaxes: readonly EditableMax[],
  deltas: readonly ImportDelta[],
  excludedKeys: ReadonlySet<string>,
  today: string,
): string {
  const newest: Row[] = [];
  const listed = new Set(reviewMaxes.map((r) => r.lift));
  for (const r of reviewMaxes) {
    if (!excludedKeys.has(r.lift)) newest.push({ lift: r.lift, weight: r.weight, date: r.date ?? today });
  }
  // A lift's first delta is its newest row, and the only one with a bare key.
  for (const d of deltas) {
    if (d.kind === 'skip' && d.key === naturalKeyOf(d) && !listed.has(d.key) && !excludedKeys.has(d.key)) {
      newest.push({ lift: d.key, weight: d.after ?? '', date: d.date ?? today });
    }
  }
  const written = newest.filter((r) => Number(r.weight) > 0);
  const dateOf = new Map(written.map((r) => [r.lift, r.date]));
  const older: Row[] = [];
  for (const d of deltas) {
    const date = dateOf.get(naturalKeyOf(d));
    if (d.key !== naturalKeyOf(d) && date !== undefined && !excludedKeys.has(d.key)) {
      older.push({ lift: naturalKeyOf(d), weight: d.after ?? '', date });
    }
  }
  const lines = [...written, ...older.filter((r) => Number(r.weight) > 0)].map(
    (r) => `${r.date},"${r.lift.replace(/"/g, '""')}",${Number(r.weight)}`,
  );
  return ['Date Updated,Lift,Weight', ...lines].join('\n');
}
