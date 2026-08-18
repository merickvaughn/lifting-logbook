import { ImportWriteResult } from '@lifting-logbook/types';
import type { ImportRowKind } from './buildImportPreview';

/** One import row with its computed natural key and classification. */
export interface ClassifiedRow<T> {
  row: T;
  kind: ImportRowKind;
  key: string;
}

/**
 * Shared dedupe + classify core for the Smart Import paths (#537).
 *
 * Both the count-only commit path (`classifyAndCount`) and the delta-producing
 * preview path (`buildImportPreview`) walk the incoming rows the same way: the
 * first row for each natural key is classified as create / update / skip; a
 * later row reusing an earlier row's key is always yielded as an explicit
 * skip (issue #884 — previously dropped with no trace at all, not even
 * counted). That loop used to be copy-pasted in both places, so a change to
 * the dedupe semantics (e.g. first-wins → last-wins, or key normalization)
 * had to be made twice or the two paths would silently disagree.
 * Centralising it here makes that a one-place change — the per-row
 * create/update/skip *decision* is already shared via the `*RowKind`
 * predicates, this shares the surrounding dedupe loop too.
 *
 * `keyOf` produces the per-row dedupe/natural key; `rowKind` decides
 * create/update/skip for a row's first occurrence (the key is passed through
 * so a classifier can reuse it instead of recomputing; it is not re-invoked
 * for a later same-key row, which is always 'skip'). Every yielded row
 * carries the key it was classified on, so consumers never recompute it —
 * but that key is NOT guaranteed unique across `deltas`/results in one call,
 * since an in-batch duplicate now yields its own entry sharing the original's
 * key; `buildImportPreview.ts`'s `dedupeDisplayKey` exists specifically to
 * give preview consumers a display-unique key without touching this one's
 * meaning.
 */
export function* classifyImportRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  rowKind: (row: T, key: string) => ImportRowKind,
): Generator<ClassifiedRow<T>> {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) {
      // A later row in this batch reuses an earlier row's key. The earlier
      // occurrence already won the create/update/skip decision and the write;
      // this one is always a skip. Surfaced explicitly (issue #884) instead of
      // silently dropped, so counts/deltas account for every incoming row —
      // a same-key-within-the-file collision was previously invisible even
      // when a same-key-vs-already-stored collision already showed as a skip.
      yield { row, kind: 'skip', key };
      continue;
    }
    seen.add(key);
    yield { row, kind: rowKind(row, key), key };
  }
}

/**
 * Shared classify-and-count loop for the Smart Import commit path (#532).
 *
 * Walks the deduped/classified rows from {@link classifyImportRows}, applies the
 * write for each non-skip row, and tallies the result, so every per-kind commit
 * method (training maxes, strength goals, program spec) and every adapter
 * (in-memory + Prisma) reports identical counts for the same input.
 *
 * `applyWrite` performs the write for a non-skip row and is awaited so callers can
 * run it inside a transaction; a throw propagates (the caller's transaction rolls
 * back) and the counts are not advanced for the failed row. The deduped natural
 * `key` is passed as the third argument so an adapter that stores by key need not
 * recompute it.
 */
export async function classifyAndCount<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  rowKind: (row: T) => ImportRowKind,
  applyWrite: (
    row: T,
    kind: 'create' | 'update',
    key: string,
  ) => void | Promise<unknown>,
): Promise<ImportWriteResult> {
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const { row, kind, key } of classifyImportRows(rows, keyOf, (r) => rowKind(r))) {
    if (kind === 'skip') {
      skipped++;
      continue;
    }

    await applyWrite(row, kind, key);
    if (kind === 'create') created++;
    else updated++;
  }

  return { created, updated, skipped };
}
