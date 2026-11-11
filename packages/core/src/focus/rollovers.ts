import type { FocusArea, FocusBlock, FocusPoolEntry } from '@lifting-logbook/types';
import { blockRange, blockStatus, nextStart } from './dates';

/**
 * The auto-roll successors that should exist but don't yet. The caller persists them,
 * idempotently on (series, start), and assigns their real ids: `id` here is a placeholder.
 *
 * A block rolls when it has started (active or ended), is set to auto-roll into a next
 * area, and nothing in its series runs on or after its successor's start date. Ended
 * blocks are included because status is derived from dates: a block that ended while
 * nobody loaded the app still owes its successor. So declining a successor means setting
 * the predecessor's `onEnd` to `'prompt'`, as the prototype's Cancel does — deleting the
 * successor alone would let it be created again.
 *
 * The successor keeps the block's settings, targets `nextArea`, starts the day after the
 * block ends, and prompts when it ends rather than rolling again. Its pool comes from
 * `poolFor`, since a new area needs new lifts.
 *
 * Under `percent_wave` progression a block is one wave, so its training maxes move by
 * `increment` into the successor (#1213): a successor lift the block also had keeps that
 * entry, with its max raised.
 */
export function expandRollovers(
  blocks: readonly FocusBlock[],
  today: string,
  poolFor: (area: FocusArea) => FocusPoolEntry[],
  increment: number,
): FocusBlock[] {
  const successors: FocusBlock[] = [];
  for (const block of blocks) {
    if (block.onEnd !== 'autoroll' || block.nextArea === null) continue;
    if (blockStatus(block, today) === 'queued') continue;
    const start = nextStart(block);
    // ISO dates compare correctly as strings.
    const covered = blocks.some((other) => other.series === block.series && blockRange(other).end >= start);
    if (covered) continue;
    successors.push({
      ...block,
      id: `roll-${block.id}`,
      area: block.nextArea,
      start,
      onEnd: 'prompt',
      nextArea: null,
      pool: successorPool(block, poolFor(block.nextArea), increment),
    });
  }
  return successors;
}

function successorPool(block: FocusBlock, pool: FocusPoolEntry[], increment: number): FocusPoolEntry[] {
  if (block.progression !== 'percent_wave') return pool;
  return pool.map((entry) => {
    const previous = block.pool.find((prior) => prior.lift === entry.lift);
    return previous ? { ...previous, trainingMax: previous.trainingMax + increment } : entry;
  });
}
