import { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { ImportPreImage } from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import { LEGACY_ROW_KEY, lockForRenumbering } from './macrocycle-history.util';

/**
 * Renumbering (proposal decision 3, ADR-042): within a user and program, macrocycles are numbered
 * 1 to N in start-date order by rewriting the stored number everywhere it's held.
 */

/**
 * The setting that turns renumbering on. Off, nothing stored is rewritten and a new macrocycle
 * keeps the number past every stored one. #1200 turns it on in the deploy that renumbers existing
 * history, records each old number for the reversal script and refuses writes with no stable id
 * (Rollout), then removes this switch.
 */
export const RENUMBERING_SETTING = 'MACROCYCLE_RENUMBERING';

export function renumberingEnabled(): boolean {
  return process.env[RENUMBERING_SETTING] === 'on';
}

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
 * A lift-records batch's pre-image with each key's number moved by `changes`, or null when no key
 * moves. Set keys start with the number (`<n>:...`, current and date-blind legacy forms alike),
 * and a `legacy` row the import created is keyed `macrocycle-row:<n>`.
 */
export function renumberPreImageKeys(preImage: ImportPreImage, changes: ReadonlyMap<number, number>): ImportPreImage | null {
  let moved = false;
  const entries = Object.entries(preImage).map(([key, entry]): [string, typeof entry] => {
    const legacy = key.startsWith(LEGACY_ROW_KEY);
    const head = legacy ? key.slice(LEGACY_ROW_KEY.length) : key.slice(0, key.indexOf(':'));
    const to = /^\d+$/.test(head) ? changes.get(Number(head)) : undefined;
    if (to === undefined) return [key, entry];
    moved = true;
    if (legacy) return [`${LEGACY_ROW_KEY}${to}`, { ...entry, wrote: { macrocycleNum: to } }];
    return [`${to}${key.slice(head.length)}`, entry];
  });
  return moved ? Object.fromEntries(entries) : null;
}

const tracer = trace.getTracer('macrocycle-renumbering');
const logger = new Logger('MacrocycleRenumbering');

/**
 * Renumbers `program` by start date, in the request's transaction, and returns the numbers it
 * moved (empty when off or when nothing moves). Every path that adds or removes a macrocycle calls
 * it after its writes: lift-record imports and their undo, starting, initializing and deleting.
 *
 * The rewrite runs under the macrocycle lock held exclusively, so no page write's id check can
 * interleave with it (decision 13). An import holds it already (`lock: 'exclusive'`). A start or a
 * delete holds it shared and takes it exclusively only when a number would move, waiting as long as
 * an import does (`lockForRenumbering`), then 409 `macrocycle-busy`; it reads the order again once
 * it has.
 *
 * A span records the macrocycles moved, the rows and batches rewritten and how long it took (raw
 * SQL isn't auto-traced, ADR-024).
 */
export async function renumberProgram(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'importBatch'>,
  program: string,
  { lock }: { lock: 'exclusive' | 'shared' },
): Promise<Map<number, number>> {
  if (!renumberingEnabled()) return new Map();
  return tracer.startActiveSpan('macrocycle.renumber', async (span) => {
    const started = Date.now();
    try {
      let changes = renumberingChanges(await repos.macrocycle.list(program));
      if (changes.size > 0 && lock === 'shared') {
        await lockForRenumbering(repos);
        changes = renumberingChanges(await repos.macrocycle.list(program));
      }
      let rows = 0;
      let batches = 0;
      if (changes.size > 0) {
        rows = await repos.macrocycle.rewriteNumbers(program, changes);
        for (const batch of await repos.importBatch.listForProgram(program, 'lift-records')) {
          const preImage = renumberPreImageKeys(batch.preImage, changes);
          if (!preImage) continue;
          await repos.importBatch.updatePreImage(batch.id, preImage);
          batches++;
        }
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
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}
