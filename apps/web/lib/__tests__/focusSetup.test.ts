import { defaultFocusPool, defaultPoolEntry } from '@lifting-logbook/core';
import { DEFAULT_FOCUS_TIMER, type FocusBlock } from '@lifting-logbook/types';
import {
  RENEW_WINDOW_DAYS,
  activeBlocks,
  anchoredPatch,
  autoRollSuccessor,
  currentWeek,
  isUsableStart,
  shiftedFollowOn,
  endsIn,
  followOnBlock,
  localToday,
  newFocusBlock,
  nextMonthName,
  renewalPrompts,
  reorderedIds,
  runLabel,
  shortDate,
  suggestedArea,
  upNext,
  withPriorities,
  type FocusWeekWorkout,
} from '../focusSetup';

const TODAY = '2026-10-26';

function block(overrides: Partial<FocusBlock> & Pick<FocusBlock, 'id'>): FocusBlock {
  return {
    series: overrides.id,
    area: 'Shoulders',
    period: 'monthly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    priority: 1,
    timer: { ...DEFAULT_FOCUS_TIMER },
    onEnd: 'prompt',
    nextArea: null,
    pool: [defaultPoolEntry('Lateral Raise')],
    ...overrides,
  };
}

describe('localToday', () => {
  it("is the browser's local calendar day, zero-padded", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('activeBlocks', () => {
  it('keeps the active blocks, highest priority first', () => {
    const blocks = [
      block({ id: 'b', priority: 2 }),
      block({ id: 'ended', start: '2026-09-01', priority: 1 }),
      block({ id: 'queued', start: '2026-11-01', priority: 3 }),
      block({ id: 'a', priority: 1 }),
    ];
    expect(activeBlocks(blocks, TODAY).map((b) => b.id)).toEqual(['a', 'b']);
  });
});

describe('upNext', () => {
  it('lists queued blocks soonest first and marks the auto-roll successor', () => {
    const shoulders = block({ id: 'sh', series: 's1', period: 'quarterly', onEnd: 'autoroll', nextArea: 'Back' });
    const rolled = block({ id: 'roll', series: 's1', area: 'Back', start: '2027-01-01' });
    const queued = block({ id: 'q', series: 's2', area: 'Core', start: '2026-11-01' });
    const rows = upNext([shoulders, rolled, queued], TODAY);
    expect(rows.map((row) => row.block.id)).toEqual(['q', 'roll']);
    expect(rows[0]?.rolledFrom).toBeUndefined();
    expect(rows[1]?.rolledFrom?.id).toBe('sh');
  });

  it('does not call a same-area renewal an auto-roll into another area', () => {
    const shoulders = block({ id: 'sh', series: 's1', onEnd: 'autoroll', nextArea: 'Back' });
    const renewal = block({ id: 'renew', series: 's1', start: '2026-11-01' });
    expect(upNext([shoulders, renewal], TODAY)[0]?.rolledFrom).toBeUndefined();
  });

  it('does not call a renewal an auto-roll when its predecessor only prompts', () => {
    const biceps = block({ id: 'bi', series: 's2', area: 'Biceps' });
    const renewed = block({ id: 'next', series: 's2', area: 'Biceps', start: '2026-11-01' });
    expect(upNext([biceps, renewed], TODAY)[0]?.rolledFrom).toBeUndefined();
  });
});

describe('renewalPrompts', () => {
  const ending = block({ id: 'bi', area: 'Biceps' }); // October: 5 days left on Oct 26

  it('prompts for a block set to prompt that ends within 10 days', () => {
    expect(renewalPrompts([ending], TODAY, new Set()).map((b) => b.id)).toEqual(['bi']);
  });

  it(`waits until the block is within ${RENEW_WINDOW_DAYS} days of its end`, () => {
    // October ends on the 31st.
    const firstDay = `2026-10-${31 - RENEW_WINDOW_DAYS}`;
    expect(renewalPrompts([ending], `2026-10-${30 - RENEW_WINDOW_DAYS}`, new Set())).toEqual([]);
    expect(renewalPrompts([ending], firstDay, new Set())).toHaveLength(1);
  });

  it('skips auto-roll blocks, dismissed blocks, and series with something queued', () => {
    expect(renewalPrompts([{ ...ending, onEnd: 'autoroll', nextArea: 'Core' }], TODAY, new Set())).toEqual([]);
    expect(renewalPrompts([ending], TODAY, new Set(['bi']))).toEqual([]);
    const queued = block({ id: 'next', series: ending.series, start: '2026-11-01' });
    expect(renewalPrompts([ending, queued], TODAY, new Set())).toEqual([]);
  });
});

describe('reorderedIds', () => {
  const a = block({ id: 'a', priority: 1 });
  const queued = block({ id: 'q', start: '2026-11-01', priority: 2 });
  const b = block({ id: 'b', priority: 3 });
  const ended = block({ id: 'old', start: '2026-09-01', priority: 4 });

  it('swaps a block with the next active one and keeps queued blocks in place', () => {
    expect(reorderedIds([a, queued, b, ended], TODAY, 'b', -1)).toEqual(['b', 'q', 'a']);
    expect(reorderedIds([a, queued, b, ended], TODAY, 'a', 1)).toEqual(['b', 'q', 'a']);
  });

  it('lists every block that has not ended and leaves ended ones out', () => {
    expect(reorderedIds([a, queued, b, ended], TODAY, 'a', 1)).not.toContain('old');
  });

  it('is null at either end', () => {
    expect(reorderedIds([a, b], TODAY, 'a', -1)).toBeNull();
    expect(reorderedIds([a, b], TODAY, 'b', 1)).toBeNull();
  });

  it('applies the new order as 1-based priorities', () => {
    const ids = ['b', 'q', 'a'];
    expect(withPriorities([a, queued, b, ended], ids).map((x) => [x.id, x.priority])).toEqual([
      ['a', 3],
      ['q', 2],
      ['b', 1],
      ['old', 4],
    ]);
  });
});

describe('anchoredPatch', () => {
  const quarterly = block({ id: 'q', period: 'quarterly', start: '2026-10-01' });

  it('keeps start when the block still covers today', () => {
    expect(anchoredPatch(quarterly, { period: 'monthly' }, '2026-10-26')).toEqual({ period: 'monthly' });
  });

  it('restarts a calendar block in this month when the change would end it', () => {
    // Monthly from Oct 1 would be October only, already over on Nov 15.
    expect(anchoredPatch(quarterly, { period: 'monthly' }, '2026-11-15')).toEqual({
      period: 'monthly',
      start: '2026-11-01',
    });
  });

  it('restarts a custom block today when the change would end it', () => {
    expect(anchoredPatch(quarterly, { align: 'custom', period: 'monthly' }, '2026-11-15')).toEqual({
      align: 'custom',
      period: 'monthly',
      start: '2026-11-15',
    });
  });

  it('leaves an explicit start and other fields alone', () => {
    expect(anchoredPatch(quarterly, { start: '2026-12-01' }, '2026-11-15')).toEqual({ start: '2026-12-01' });
    expect(anchoredPatch(quarterly, { overlap: 'skip' }, '2026-11-15')).toEqual({ overlap: 'skip' });
  });
});

describe('shiftedFollowOn', () => {
  const october = block({ id: 'oct', series: 's' });
  const november = block({ id: 'nov', series: 's', start: '2026-11-01' });

  it('moves a queued follow-on past a longer period instead of overlapping it', () => {
    const quarter = { ...october, period: 'quarterly' as const };
    expect(shiftedFollowOn([october, november], october, quarter, TODAY)).toEqual({ id: 'nov', start: '2027-01-01' });
  });

  it('moves it up to close the gap a shorter period leaves', () => {
    const fromQuarter = { ...october, period: 'quarterly' as const };
    const january = block({ id: 'jan', series: 's', start: '2027-01-01' });
    expect(shiftedFollowOn([fromQuarter, january], fromQuarter, october, TODAY)).toEqual({ id: 'jan', start: '2026-11-01' });
  });

  it('is null when nothing follows, or it already starts in the right place', () => {
    expect(shiftedFollowOn([october], october, { ...october, overlap: 'skip' }, TODAY)).toBeNull();
    expect(shiftedFollowOn([october, november], october, { ...october, overlap: 'skip' }, TODAY)).toBeNull();
  });
});

describe('autoRollSuccessor', () => {
  it("is the queued block the API rolled the block into, if any", () => {
    const shoulders = block({ id: 'sh', series: 's1', onEnd: 'autoroll', nextArea: 'Back' });
    const back = block({ id: 'back', series: 's1', area: 'Back', start: '2026-11-01' });
    expect(autoRollSuccessor([shoulders, back], shoulders, TODAY)?.id).toBe('back');
    expect(autoRollSuccessor([shoulders], shoulders, TODAY)).toBeUndefined();
  });
});

describe('isUsableStart', () => {
  const custom = block({ id: 'c', align: 'custom', start: '2026-10-12' });

  it('accepts a real date the block can run from', () => {
    expect(isUsableStart(custom, '2026-10-20', TODAY)).toBe(true);
    expect(isUsableStart(custom, '2026-12-01', TODAY)).toBe(true);
  });

  it('rejects the partial years a date input reports while typing', () => {
    expect(isUsableStart(custom, '0002-10-26', TODAY)).toBe(false);
    expect(isUsableStart(custom, '0202-10-26', TODAY)).toBe(false);
  });

  it('rejects a date that would end the block, and a non-date', () => {
    expect(isUsableStart(custom, '2026-08-01', TODAY)).toBe(false);
    expect(isUsableStart(custom, '2026-02-30', TODAY)).toBe(false);
  });
});

describe('suggestedArea', () => {
  it('is the first area with no active block', () => {
    expect(suggestedArea([block({ id: 'a' }), block({ id: 'b', area: 'Biceps' })], TODAY)).toBe('Triceps');
  });
});

describe('newFocusBlock', () => {
  it("starts this calendar month with the area's default pool", () => {
    expect(newFocusBlock('Calves', TODAY)).toEqual({
      area: 'Calves',
      period: 'monthly',
      align: 'calendar',
      start: '2026-10-01',
      selection: 'rules',
      overlap: 'reduce',
      progression: 'double',
      timer: DEFAULT_FOCUS_TIMER,
      onEnd: 'prompt',
      nextArea: null,
      pool: defaultFocusPool('Calves'),
    });
  });
});

describe('followOnBlock', () => {
  const shoulders = block({
    id: 'sh',
    series: 's1',
    period: 'quarterly',
    pool: [{ ...defaultPoolEntry('Face Pull'), sets: 4 }],
  });

  it('renews in the same series the day after the block ends, keeping the pool', () => {
    const next = followOnBlock(shoulders, 'Shoulders');
    expect(next).toMatchObject({ series: 's1', area: 'Shoulders', start: '2027-01-01', period: 'quarterly' });
    expect(next.pool).toEqual(shoulders.pool);
    expect(next.pool[0]).not.toBe(shoulders.pool[0]);
  });

  it("gives a different area that area's default pool", () => {
    expect(followOnBlock(shoulders, 'Core').pool).toEqual(defaultFocusPool('Core'));
  });
});

describe('currentWeek', () => {
  const workouts: FocusWeekWorkout[] = [
    { workoutNum: 1, week: 1, date: '2026-10-19', done: true },
    { workoutNum: 2, week: 1, date: '2026-10-21', done: true },
    { workoutNum: 3, week: 2, date: '2026-10-26', done: false },
    { workoutNum: 4, week: 2, date: '2026-10-28', done: false },
  ];

  it('is the week of the next workout not yet done', () => {
    expect(currentWeek(workouts, TODAY).map((w) => w.workoutNum)).toEqual([3, 4]);
  });

  it('is the last week once every workout is behind', () => {
    expect(currentWeek(workouts, '2026-12-01').map((w) => w.workoutNum)).toEqual([3, 4]);
  });

  it('is empty without workouts', () => {
    expect(currentWeek([], TODAY)).toEqual([]);
  });
});

describe('labels', () => {
  it('formats dates, runs, months and countdowns', () => {
    expect(shortDate('2026-10-26')).toBe('Mon, Oct 26');
    expect(runLabel('2026-10-01', '2026-12-31')).toBe('Oct 1 – Dec 31, 2026');
    expect(nextMonthName(block({ id: 'a' }))).toBe('November');
    expect(endsIn(0)).toBe('today');
    expect(endsIn(1)).toBe('in 1 day');
    expect(endsIn(6)).toBe('in 6 days');
  });
});
