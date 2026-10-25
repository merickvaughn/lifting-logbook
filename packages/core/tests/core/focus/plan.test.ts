import { focusDurationSec, focusLiftCostSec, planFocusDay } from '@src/core';
import { block, entry, resolveMuscles } from './focusFixtures';

describe('focus timing', () => {
  const timer = { prep: 10, set: 45, rest: 60 };

  it('times sets with a rest between each, and charges one extra rest per lift', () => {
    expect(focusDurationSec(3, timer)).toBe(3 * 55 + 2 * 60);
    expect(focusDurationSec(1, timer)).toBe(55);
    expect(focusDurationSec(0, timer)).toBe(0);
    expect(focusLiftCostSec(3, timer)).toBe(285 + 60);
  });
});

describe('planFocusDay', () => {
  const shoulders = block({ id: 'sh', priority: 1, pool: [entry('Lateral Raise'), entry('Upright Row')] });
  const biceps = block({ id: 'bi', area: 'Biceps', priority: 2, pool: [entry('Hammer Curl'), entry('Cable Curl')] });
  const queued = block({ id: 'q', area: 'Core', priority: 0, start: '2027-01-01' });
  const ended = block({ id: 'e', area: 'Chest', priority: 0, start: '2026-07-01' });
  const base = { plannedLifts: [], rotationIndex: 0, today: '2026-10-23', resolveMuscles };

  it('plans active blocks only, highest priority first, with totals', () => {
    const plan = planFocusDay({ ...base, blocks: [biceps, queued, shoulders, ended], budget: { sets: 20, minutes: 60 } });
    expect(plan.groups.map((g) => g.block.id)).toEqual(['sh', 'bi']);
    expect(plan.sets).toBe(12);
    expect(plan.seconds).toBe(4 * 345);
    expect(plan.over).toBe(false);
    expect(plan.suggestion).toBeNull();
  });

  it('suggests trimming the last lift of the lowest-priority block when over on sets', () => {
    const plan = planFocusDay({ ...base, blocks: [shoulders, biceps], budget: { sets: 9, minutes: 60 } });
    expect(plan.over).toBe(true);
    expect(plan.suggestion).toEqual({ blockId: 'bi', lift: 'Cable Curl', sets: 9, seconds: 3 * 345 });
  });

  it('is over on minutes alone', () => {
    const plan = planFocusDay({ ...base, blocks: [shoulders], budget: { sets: 20, minutes: 11 } });
    expect(plan.seconds / 60).toBeCloseTo(11.5);
    expect(plan.over).toBe(true);
  });

  it('skips past a lowest-priority block with nothing left', () => {
    const triceps = block({ id: 'tri', area: 'Triceps', priority: 2, overlap: 'skip', pool: [entry('Pushdown')] });
    const plan = planFocusDay({
      ...base,
      plannedLifts: ['Fixture Dips'],
      blocks: [shoulders, triceps],
      budget: { sets: 1, minutes: 60 },
    });
    expect(plan.suggestion).toMatchObject({ blockId: 'sh', lift: 'Upright Row', sets: 3 });
  });

  it('applies trims before totalling', () => {
    const plan = planFocusDay({
      ...base,
      blocks: [shoulders, biceps],
      dayState: { modes: {}, picks: {}, trims: { bi: ['Cable Curl'] } },
      budget: { sets: 9, minutes: 60 },
    });
    expect(plan.groups.map((g) => g.trimmed)).toEqual([[], ['Cable Curl']]);
    expect(plan.groups.map((g) => g.selection.items.map((i) => i.lift))).toEqual([
      ['Lateral Raise', 'Upright Row'],
      ['Hammer Curl'],
    ]);
    expect(plan.sets).toBe(9);
    expect(plan.over).toBe(false);
  });
});
