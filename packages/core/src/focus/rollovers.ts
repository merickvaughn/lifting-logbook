import type { FocusArea, FocusBlock, FocusPoolEntry } from '@lifting-logbook/types';
import { blockStatus, nextStart } from './dates';

/**
 * The auto-roll successors that should exist but don't yet. The caller persists them,
 * idempotently on (series, start).
 *
 * A block rolls when it has started (active or ended), is set to auto-roll into a next
 * area, and nothing in its series starts on or after its successor's start date. Ended
 * blocks are included because status is derived from dates: a block that ended while
 * nobody loaded the app still owes its successor.
 *
 * The successor keeps the block's settings, targets `nextArea`, starts the day after the
 * block ends, and prompts when it ends rather than rolling again. Its pool comes from
 * `poolFor`, since a new area needs new lifts; core leaves that choice to the caller.
 */
export function expandRollovers(
  blocks: readonly FocusBlock[],
  today: Date,
  poolFor: (area: FocusArea) => FocusPoolEntry[] = () => [],
): FocusBlock[] {
  const successors: FocusBlock[] = [];
  for (const block of blocks) {
    if (block.onEnd !== 'autoroll' || block.nextArea === null) continue;
    if (blockStatus(block, today) === 'queued') continue;
    const start = nextStart(block);
    // ISO dates compare correctly as strings.
    if (blocks.some((other) => other.series === block.series && other.start >= start)) continue;
    successors.push({
      ...block,
      id: `roll-${block.id}`,
      area: block.nextArea,
      start,
      onEnd: 'prompt',
      nextArea: null,
      pool: poolFor(block.nextArea),
    });
  }
  return successors;
}
