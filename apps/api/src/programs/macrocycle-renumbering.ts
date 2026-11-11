import { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ImportPreImage } from '@lifting-logbook/core';
import { MacrocycleNumberConflictError } from '../ports/errors';
import { RepositoryBundle } from '../ports/factory';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import { preImageKeyNumber } from '../ports/IImportBatchRepository';
import { LEGACY_ROW_KEY, lockForRenumbering } from './macrocycle-history.util';

/**
 * Renumbering (proposal decision 3, ADR-042): within a user and program, macrocycles are numbered
 * 1 to N in start-date order by rewriting the stored number everywhere it's held.
 */

const tracer = trace.getTracer('macrocycle-renumbering');
const logger = new Logger('MacrocycleRenumbering');

/**
 * Old number → new number for each of `rows` whose number changes. `rows` come in start-date
 * order with ties by number, as `IMacrocycleRepository.list` returns them, so ties keep their
 * order and a new macrocycle, given the number past every stored one, sorts after those it ties
 * with: undoing it puts the old numbers back.
 */
export function renumberingChanges(rows: readonly Pick<MacrocycleRow, 'macrocycleNum'>[]): Map<number, number> {
  const changes = new Map<number, number>();
  rows.forEach((row, i) => {
    if (row.macrocycleNum !== i + 1) changes.set(row.macrocycleNum, i + 1);
  });
  return changes;
}

/**
 * The renumbering of `program` as stored now: {@link renumberingChanges} for its macrocycles, plus
 * the rows on numbers past every macrocycle that have no `macrocycle` row, such as a focus state
 * saved before initializing. Those belong to the next macrocycle to start, which takes the number
 * after the last one, so they move there with the rest; left behind, they'd sit past a gap.
 * Numbered 1 to N already, nothing moves, and such rows are on N + 1.
 */
async function plannedChanges(repos: Pick<RepositoryBundle, 'macrocycle'>, program: string): Promise<Map<number, number>> {
  const rows = await repos.macrocycle.list(program);
  const changes = renumberingChanges(rows);
  if (changes.size === 0) return changes;
  const highest = Math.max(...rows.map((r) => r.macrocycleNum));
  (await repos.macrocycle.numbersInUse(program, highest)).forEach((n, i) => {
    const to = rows.length + 1 + i;
    if (n !== to) changes.set(n, to);
  });
  return changes;
}

/**
 * A lift-records batch's pre-image with each key's number moved by `changes`, or null when no key
 * moves. Set keys start with the number (`<n>:...`, current and date-blind legacy forms alike),
 * and a `legacy` row the import created is keyed `macrocycle-row:<n>`.
 */
export function renumberPreImageKeys(preImage: ImportPreImage, changes: ReadonlyMap<number, number>): ImportPreImage | null {
  let moved = false;
  const entries = Object.entries(preImage).map(([key, entry]): [string, typeof entry] => {
    const from = preImageKeyNumber(key);
    const to = from === null ? undefined : changes.get(from);
    if (to === undefined) return [key, entry];
    moved = true;
    if (key.startsWith(LEGACY_ROW_KEY)) return [`${LEGACY_ROW_KEY}${to}`, { ...entry, wrote: { macrocycleNum: to } }];
    const colon = key.indexOf(':');
    return [`${to}${colon === -1 ? '' : key.slice(colon)}`, entry];
  });
  return moved ? Object.fromEntries(entries) : null;
}

/**
 * Renumbers `program` by start date, in the request's transaction, and returns the numbers it
 * moved (empty when nothing moves). Every path that adds or removes a macrocycle calls
 * it after its writes: lift-record imports and their undo, starting, initializing and deleting.
 *
 * When a number would move it takes the macrocycle lock exclusively, so no page write's id check
 * can interleave with the rewrite (decision 13): at once for an import, which holds it already,
 * and otherwise waiting as long as an import does (`lockForRenumbering`), then 409
 * `macrocycle-busy`. It reads the order again once it has the lock.
 *
 * A span records the numbers moved, the rows and batches rewritten, how long it waited for the
 * lock and how long it took once it had the lock (raw SQL isn't auto-traced, ADR-024). A failure
 * is recorded on the span, with the table and number
 * that blocked a rewrite, and logged as a warning.
 */
export async function renumberProgram(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'importBatch'>,
  program: string,
): Promise<Map<number, number>> {
  return tracer.startActiveSpan('macrocycle.renumber', async (span) => {
    let started = Date.now();
    let changes = new Map<number, number>();
    try {
      changes = await plannedChanges(repos, program);
      if (changes.size > 0) {
        await lockForRenumbering(repos);
        span.setAttribute('renumber.lock_wait_ms', Date.now() - started);
        started = Date.now();
        changes = await plannedChanges(repos, program);
      }
      let rows = 0;
      let batches = 0;
      if (changes.size > 0) {
        rows = await repos.macrocycle.rewriteNumbers(program, changes);
        const updates = [];
        for (const batch of await repos.importBatch.listWithKeysOn(program, 'lift-records', { on: [...changes.keys()] })) {
          const preImage = renumberPreImageKeys(batch.preImage, changes);
          if (preImage) updates.push({ id: batch.id, preImage });
        }
        await repos.importBatch.updatePreImages(updates);
        batches = updates.length;
      }
      const durationMs = Date.now() - started;
      span.setAttribute('renumber.macrocycles', changes.size);
      span.setAttribute('renumber.rows_rewritten', rows);
      span.setAttribute('renumber.batches_rewritten', batches);
      span.setAttribute('renumber.duration_ms', durationMs);
      if (changes.size > 0) {
        logger.log({ program, macrocycles: changes.size, rows, batches, durationMs }, 'Renumbered macrocycles');
      }
      return changes;
    } catch (err) {
      const detail = err instanceof MacrocycleNumberConflictError ? err.detail : undefined;
      if (detail?.table) span.setAttribute('renumber.conflict_table', detail.table);
      if (detail?.heldNumber !== undefined) span.setAttribute('renumber.conflict_number', detail.heldNumber);
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR });
      logger.warn(
        {
          program,
          moves: Object.fromEntries(changes),
          table: detail?.table,
          heldNumber: detail?.heldNumber,
          cause: detail?.cause instanceof Error ? detail.cause.message : detail?.cause,
          error: err instanceof Error ? err.message : String(err),
        },
        'Renumbering failed',
      );
      throw err;
    } finally {
      span.end();
    }
  });
}
