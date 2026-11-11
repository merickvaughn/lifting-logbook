import { blockStatus, expandRollovers, prescribe } from '@src/core';
import { block, entry } from './focusFixtures';

describe('expandRollovers', () => {
  const rolling = block({ onEnd: 'autoroll', nextArea: 'Back' });
  const noPool = () => [];

  it('creates the successor of an active auto-roll block', () => {
    const poolFor = jest.fn(() => [entry('Lat Pulldown')]);
    const successors = expandRollovers([rolling], '2026-10-23', poolFor, 2.5);
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
    expect(expandRollovers([rolling], '2027-02-01', noPool, 2.5)).toHaveLength(1);
  });

  it('is idempotent once the successor exists', () => {
    const successors = expandRollovers([rolling], '2026-10-23', noPool, 2.5);
    expect(expandRollovers([rolling, ...successors], '2026-10-23', noPool, 2.5)).toEqual([]);
  });

  it('skips blocks that prompt, have no next area, or have not started', () => {
    expect(expandRollovers([block({ onEnd: 'prompt', nextArea: 'Back' })], '2026-10-23', noPool, 2.5)).toEqual([]);
    expect(expandRollovers([block({ onEnd: 'autoroll', nextArea: null })], '2026-10-23', noPool, 2.5)).toEqual([]);
    expect(expandRollovers([rolling], '2026-09-15', noPool, 2.5)).toEqual([]);
  });

  it('treats a same-series block running into the successor start as covering it', () => {
    const overlapping = block({ id: 'x', align: 'custom', period: 'monthly', start: '2026-12-20' });
    expect(expandRollovers([rolling, overlapping], '2026-10-23', noPool, 2.5)).toEqual([]);
  });

  describe('under percent_wave progression (#1213)', () => {
    // The proposal's example: Cable Curl, max 60 at 80% for 10, increment 2.5. The block
    // plans 47.5; its successor starts from a max of 62.5, so it plans 50.
    const curl = entry('Cable Curl', { trainingMax: 60, percent: 80, repsHigh: 10 });
    const biceps = block({
      id: 'bi',
      area: 'Biceps',
      progression: 'percent_wave',
      onEnd: 'autoroll',
      nextArea: 'Biceps',
      pool: [curl, entry('Hammer Curl', { trainingMax: 50 })],
    });
    const freshPool = () => [entry('Cable Curl'), entry('Spider Curl')];

    it('raises the max of every lift the successor shares with the block, by the increment', () => {
      const [successor] = expandRollovers([biceps], '2026-10-23', freshPool, 2.5);
      const carried = { ...curl, trainingMax: 62.5 };
      expect(successor?.pool).toEqual([carried, entry('Spider Curl')]);
      expect(prescribe(biceps, curl, 3, 2.5)).toMatchObject({ weight: 47.5 });
      expect(prescribe(biceps, carried, 3, 2.5)).toMatchObject({ weight: 50 });
    });

    it('leaves the successor pool alone under any other progression', () => {
      const [successor] = expandRollovers([{ ...biceps, progression: 'manual' }], '2026-10-23', freshPool, 2.5);
      expect(successor?.pool).toEqual(freshPool());
    });
  });

  it('ignores other series and earlier blocks in the same series', () => {
    const otherSeries = block({ id: 'x', series: 's9', start: '2027-01-01' });
    const earlier = block({ id: 'old', start: '2026-07-01' });
    expect(expandRollovers([rolling, otherSeries, earlier], '2026-10-23', noPool, 2.5)).toHaveLength(1);
  });
});
