import {
  autoRollSource,
  barPlacement,
  blockWeek,
  calendarWindow,
  dateSpanLabel,
  datedProgramPhases,
  focusLanes,
  monthTicks,
  todayOffset,
} from '../focusCalendar';
import { makeBlock } from './focusBlockFixture';

// Sep 1 2026 – Mar 31 2027: 212 days, as in the prototype's FW_RANGE.
const WINDOW = { start: '2026-09-01', end: '2027-03-31' };
const SPAN_DAYS = 212;
const pct = (days: number) => (days / SPAN_DAYS) * 100;

describe('calendarWindow', () => {
  it('runs from the month before today through five months after', () => {
    expect(calendarWindow('2026-10-23')).toEqual(WINDOW);
  });

  it('crosses a year boundary at both ends', () => {
    expect(calendarWindow('2026-01-15')).toEqual({ start: '2025-12-01', end: '2026-06-30' });
    expect(calendarWindow('2026-08-31')).toEqual({ start: '2026-07-01', end: '2027-01-31' });
  });
});

describe('barPlacement', () => {
  it('places a bar from the start of its first day to the end of its last', () => {
    // Oct 1 is 30 days in; Oct 1–31 is 31 days wide.
    const placement = barPlacement('2026-10-01', '2026-10-31', WINDOW);
    expect(placement?.left).toBeCloseTo(pct(30));
    expect(placement?.width).toBeCloseTo(pct(31));
  });

  it('fills the whole track for a bar spanning the whole window', () => {
    expect(barPlacement('2026-09-01', '2027-03-31', WINDOW)).toEqual({ left: 0, width: 100 });
  });

  it('cuts a bar that starts before the window at its left edge', () => {
    // A Q3 block, Jul 1 – Sep 30: only its 30 September days show.
    const placement = barPlacement('2026-07-01', '2026-09-30', WINDOW);
    expect(placement?.left).toBe(0);
    expect(placement?.width).toBeCloseTo(pct(30));
  });

  it('cuts a bar that runs past the window at its right edge', () => {
    const placement = barPlacement('2027-03-01', '2027-05-31', WINDOW);
    expect(placement?.left).toBeCloseTo(pct(181));
    expect((placement?.left ?? 0) + (placement?.width ?? 0)).toBeCloseTo(100);
  });

  it('returns null for a bar entirely outside the window', () => {
    expect(barPlacement('2026-07-01', '2026-08-31', WINDOW)).toBeNull();
    expect(barPlacement('2027-04-01', '2027-04-30', WINDOW)).toBeNull();
  });

  it('gives a one-day bar one day of width', () => {
    expect(barPlacement('2026-09-01', '2026-09-01', WINDOW)?.width).toBeCloseTo(pct(1));
  });
});

describe('todayOffset', () => {
  it('marks the middle of today', () => {
    // Oct 23 is 52 days in.
    expect(todayOffset('2026-10-23', WINDOW)).toBeCloseTo(pct(52.5));
  });
});

describe('monthTicks', () => {
  it('ticks the first of every month, adding the year on January', () => {
    const ticks = monthTicks(WINDOW);
    expect(ticks.map((t) => t.label)).toEqual(['Sep', 'Oct', 'Nov', 'Dec', 'Jan ’27', 'Feb', 'Mar']);
    expect(ticks[0]?.left).toBe(0);
    expect(ticks[1]?.left).toBeCloseTo(pct(30));
  });
});

describe('dateSpanLabel', () => {
  it('names both days and the year of the last', () => {
    expect(dateSpanLabel('2026-12-07', '2027-01-03')).toBe('Dec 7 – Jan 3, 2027');
  });
});

describe('focusLanes', () => {
  it('makes one lane per series, oldest focus block first, ordered by the active priority', () => {
    const lanes = focusLanes(
      [
        makeBlock({ id: 'bi', series: 's2', area: 'Biceps', priority: 2 }),
        makeBlock({ id: 'sh', series: 's1', priority: 1, period: 'quarterly', rangeEnd: '2026-12-31' }),
        makeBlock({
          id: 'bi-sep',
          series: 's2',
          area: 'Biceps',
          priority: 9,
          status: 'ended',
          start: '2026-09-01',
          rangeStart: '2026-09-01',
          rangeEnd: '2026-09-30',
        }),
      ],
      WINDOW,
    );
    expect(lanes.map((l) => l.series)).toEqual(['s1', 's2']);
    expect(lanes[1]?.blocks.map((b) => b.id)).toEqual(['bi-sep', 'bi']);
    expect(lanes.map((l) => l.label)).toEqual(['Quarterly', 'Monthly']);
  });

  it('labels a custom-start series with its start day', () => {
    const lanes = focusLanes(
      [
        makeBlock({ align: 'custom', start: '2026-10-12', rangeStart: '2026-10-12', rangeEnd: '2026-11-11' }),
        makeBlock({ id: 'b2', series: 's2', align: 'custom', start: '2026-10-01', rangeEnd: '2026-10-31' }),
        makeBlock({ id: 'b3', series: 's3', align: 'custom', start: '2026-10-22', rangeStart: '2026-10-22', rangeEnd: '2026-11-21' }),
      ],
      WINDOW,
    );
    expect(lanes.map((l) => l.label)).toEqual([
      'Monthly · from the 12th',
      'Monthly · from the 1st',
      'Monthly · from the 22nd',
    ]);
  });

  it('ranks a series that has not started by its queued priority, and an ended series last', () => {
    const lanes = focusLanes(
      [
        makeBlock({ id: 'q', series: 'later', priority: 1, status: 'queued', start: '2026-11-01', rangeStart: '2026-11-01', rangeEnd: '2026-11-30' }),
        makeBlock({ id: 'old', series: 'done', priority: 1, status: 'ended', start: '2026-09-01', rangeStart: '2026-09-01', rangeEnd: '2026-09-30' }),
        makeBlock({ id: 'a', series: 'now', priority: 3 }),
      ],
      WINDOW,
    );
    expect(lanes.map((l) => l.series)).toEqual(['later', 'now', 'done']);
  });

  it('drops a series whose focus blocks are all outside the window', () => {
    const lanes = focusLanes(
      [makeBlock({ status: 'ended', start: '2026-04-01', rangeStart: '2026-04-01', rangeEnd: '2026-06-30' })],
      WINDOW,
    );
    expect(lanes).toEqual([]);
  });
});

describe('blockWeek', () => {
  const quarter = { rangeStart: '2026-10-01', rangeEnd: '2026-12-31' };

  it('counts the first seven days as week 1', () => {
    expect(blockWeek(quarter, '2026-10-01')).toEqual({ week: 1, weeks: 14 });
    expect(blockWeek(quarter, '2026-10-07')).toEqual({ week: 1, weeks: 14 });
    expect(blockWeek(quarter, '2026-10-08')).toEqual({ week: 2, weeks: 14 });
  });

  it('stays within the focus block', () => {
    expect(blockWeek(quarter, '2026-12-31').week).toBe(14);
    expect(blockWeek(quarter, '2026-09-01').week).toBe(1);
  });
});

describe('autoRollSource', () => {
  const rolling = makeBlock({ id: 'sh', onEnd: 'autoroll', nextArea: 'Back', period: 'quarterly', rangeEnd: '2026-12-31' });
  const successor = makeBlock({ id: 'back', area: 'Back', status: 'queued', start: '2027-01-01', rangeStart: '2027-01-01', rangeEnd: '2027-03-31' });

  it('finds the focus block a queued one rolls from', () => {
    expect(autoRollSource(successor, [rolling, successor])?.id).toBe('sh');
  });

  it('is undefined for a focus block the user queued after one that prompts', () => {
    expect(autoRollSource(successor, [{ ...rolling, onEnd: 'prompt' }, successor])).toBeUndefined();
  });

  it('is undefined when the rolling focus block is in another series', () => {
    expect(autoRollSource(successor, [{ ...rolling, series: 'other' }, successor])).toBeUndefined();
  });
});

describe('datedProgramPhases', () => {
  const days = [
    { workoutNum: 1, week: 1, date: '2026-09-07' },
    { workoutNum: 2, week: 2, date: '2026-09-14' },
    { workoutNum: 3, week: 3, date: '2026-09-21' },
    { workoutNum: 4, week: 4, date: '2026-09-28' },
  ];
  const phases = [
    { name: 'Mesocycle 1', type: 'training' as const, startWeek: 1, endWeek: 2 },
    { name: 'Mesocycle 2', type: 'training' as const, startWeek: 3, endWeek: 4 },
    { name: 'Mesocycle 3', type: 'training' as const, startWeek: 5, endWeek: 6 },
  ];

  it('dates each phase from its first and last workouts, leaving out phases with none', () => {
    expect(datedProgramPhases(phases, days, (d) => d.date)).toEqual([
      { name: 'Mesocycle 1', type: 'training', start: '2026-09-07', end: '2026-09-14', weeks: 2 },
      { name: 'Mesocycle 2', type: 'training', start: '2026-09-21', end: '2026-09-28', weeks: 2 },
    ]);
  });

  it('dates workouts as the dashboard does, so a rescheduled one moves its phase', () => {
    const moved = (d: { workoutNum: number; date: string }) => (d.workoutNum === 2 ? '2026-09-17' : d.date);
    expect(datedProgramPhases(phases, days, moved)[0]?.end).toBe('2026-09-17');
  });
});
