import { blockStatus, expandRollovers } from '@src/core';
import { block, entry } from './focusFixtures';

describe('expandRollovers', () => {
  const rolling = block({ onEnd: 'autoroll', nextArea: 'Back' });
  const noPool = () => [];

  it('creates the successor of an active auto-roll block', () => {
    const poolFor = jest.fn(() => [entry('Lat Pulldown')]);
    const successors = expandRollovers([rolling], '2026-10-23', poolFor);
    expect(poolFor).toHaveBeenCalledWith('Back');
    expect(successors).toEqual([
      {
        ...rolling,
        id: 'roll-sh',
        area: 'Back',
        start: '2027-01-01',
        onEnd: 'prompt',
        nextArea: null,
        pool: [entry('Lat Pulldown')],
      },
    ]);
    expect(successors.map((s) => blockStatus(s, '2026-10-23'))).toEqual(['queued']);
  });

  it('still creates the successor once the block has ended', () => {
    expect(expandRollovers([rolling], '2027-02-01', noPool)).toHaveLength(1);
  });

  it('is idempotent once the successor exists', () => {
    const successors = expandRollovers([rolling], '2026-10-23', noPool);
    expect(expandRollovers([rolling, ...successors], '2026-10-23', noPool)).toEqual([]);
  });

  it('skips blocks that prompt, have no next area, or have not started', () => {
    expect(expandRollovers([block({ onEnd: 'prompt', nextArea: 'Back' })], '2026-10-23', noPool)).toEqual([]);
    expect(expandRollovers([block({ onEnd: 'autoroll', nextArea: null })], '2026-10-23', noPool)).toEqual([]);
    expect(expandRollovers([rolling], '2026-09-15', noPool)).toEqual([]);
  });

  it('treats a same-series block running into the successor start as covering it', () => {
    const overlapping = block({ id: 'x', align: 'custom', period: 'monthly', start: '2026-12-20' });
    expect(expandRollovers([rolling, overlapping], '2026-10-23', noPool)).toEqual([]);
  });

  it('ignores other series and earlier blocks in the same series', () => {
    const otherSeries = block({ id: 'x', series: 's9', start: '2027-01-01' });
    const earlier = block({ id: 'old', start: '2026-07-01' });
    expect(expandRollovers([rolling, otherSeries, earlier], '2026-10-23', noPool)).toHaveLength(1);
  });
});
