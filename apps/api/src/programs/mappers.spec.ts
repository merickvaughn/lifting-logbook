import { CycleDashboard, LiftRecord, LiftingProgramSpec, Weekday } from '@lifting-logbook/core';
import {
  applyLiftOverrides,
  buildCycleDashboardResponse,
  toLiftRecordResponse,
  toWorkoutResponse,
  weekForWorkoutNum,
  workoutKeyForWorkoutNum,
} from './mappers';
import { LiftOverride } from '../ports/IWorkoutLiftOverrideRepository';
import { ScheduledWorkout } from '../ports/ICycleScheduledWorkoutRepository';

const baseFields: Omit<LiftingProgramSpec, 'offset' | 'lift' | 'week'> = {
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: true,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0.1,
  activation: 'compound',
};

const spec = (offset: number, lift: string, week?: number): LiftingProgramSpec => ({
  ...baseFields,
  offset,
  lift: lift as LiftingProgramSpec['lift'],
  ...(week !== undefined ? { week } : {}),
});

// Pre-#740 weekForWorkoutNum indexed workoutNum into the stored block's distinct
// offsets and returned undefined (→ 400) beyond that count. #740 tiles the block to
// the program's canonical length first and indexes into the ordered (week, offset)
// workout days (the same orderedWorkoutKeys mapping the web grid uses), so week-2+
// workouts resolve in no-schedule mode too; undefined now means past the *full*
// canonical length. These tests replace the old offset-cap assertions.
describe('toLiftRecordResponse', () => {
  const liftRecord = (overrides: Partial<LiftRecord> = {}): LiftRecord => ({
    program: '5-3-1',
    cycleNum: 4,
    workoutNum: 1,
    date: new Date('2026-04-20T00:00:00.000Z'),
    lift: 'Bench Press',
    setNum: 1,
    weight: 180,
    reps: 5,
    notes: '',
    ...overrides,
  });

  // Regression for issue #884: the public id must include a date segment so two
  // records sharing every other field on different dates get distinct ids.
  it('builds an id including the date segment', () => {
    const response = toLiftRecordResponse(liftRecord());
    expect(response.id).toBe('5-3-1-4-1-20260420-Bench Press-1');
  });

  it('builds an id for a hyphenated lift name without ambiguity', () => {
    const response = toLiftRecordResponse(liftRecord({ lift: 'Romanian Dead-lift' }));
    expect(response.id).toBe('5-3-1-4-1-20260420-Romanian Dead-lift-1');
  });

  it('produces different ids for records differing only by date', () => {
    const a = toLiftRecordResponse(liftRecord({ date: new Date('2025-12-16') }));
    const b = toLiftRecordResponse(liftRecord({ date: new Date('2024-01-12') }));
    expect(a.id).not.toBe(b.id);
  });
});

describe('weekForWorkoutNum', () => {
  it('returns undefined for empty spec', () => {
    expect(weekForWorkoutNum([], 1)).toBeUndefined();
  });

  it('maps workoutNum to the (week, offset) day in order for a multi-week block', () => {
    // Two offsets per week across weeks 1..2. No registered program → canonical
    // length falls back to the base block size (2 weeks) = 4 workout days.
    const s = [
      spec(0, 'Squat', 1),
      spec(3, 'Deadlift', 1),
      spec(0, 'Squat', 2),
      spec(3, 'Deadlift', 2),
    ];
    expect(weekForWorkoutNum(s, 1)).toBe(1); // (w1, o0)
    expect(weekForWorkoutNum(s, 2)).toBe(1); // (w1, o3)
    expect(weekForWorkoutNum(s, 3)).toBe(2); // (w2, o0)
    expect(weekForWorkoutNum(s, 4)).toBe(2); // (w2, o3)
    expect(weekForWorkoutNum(s, 5)).toBeUndefined(); // past full length
  });

  it('deduplicates offsets — two lifts at the same offset are one workout day', () => {
    const s = [spec(0, 'Squat', 1), spec(0, 'Bench Press', 1), spec(3, 'Deadlift', 1)];
    // 1-week block of 2 offsets → base length 1 week → 2 workout days.
    expect(weekForWorkoutNum(s, 1)).toBe(1);
    expect(weekForWorkoutNum(s, 2)).toBe(1);
    expect(weekForWorkoutNum(s, 3)).toBeUndefined();
  });

  it('tiles a single-week repeating block to the program canonical length (issue #740)', () => {
    // Leangains: a 1-week block of offsets {0,2,4} tiled across 12 weeks = 36 days.
    const s = [spec(0, 'Bench Press', 1), spec(2, 'Squat', 1), spec(4, 'Overhead Press', 1)];
    expect(weekForWorkoutNum(s, 3, 'leangains')).toBe(1); // last workout of week 1
    expect(weekForWorkoutNum(s, 4, 'leangains')).toBe(2); // first of week 2 — 400'd pre-#740
    expect(weekForWorkoutNum(s, 36, 'leangains')).toBe(12); // final workout
    expect(weekForWorkoutNum(s, 37, 'leangains')).toBeUndefined(); // beyond 12 weeks
  });

  it('falls back to the base-spec block length for an unregistered program', () => {
    const s = [spec(0, 'Squat', 1), spec(0, 'Squat', 2), spec(0, 'Squat', 3)];
    expect(weekForWorkoutNum(s, 3, 'a-custom-uuid')).toBe(3);
    expect(weekForWorkoutNum(s, 4, 'a-custom-uuid')).toBeUndefined();
  });
});

describe('workoutKeyForWorkoutNum', () => {
  it('returns the (week, offset) key for a tiled Leangains block', () => {
    // 1-week block of offsets {0,2} → tiled to 12 weeks = 24 workout days. The offset
    // (not just the week) is what the no-schedule detail date needs (issue #745).
    const s = [spec(0, 'Bench Press', 1), spec(2, 'Squat', 1)];
    expect(workoutKeyForWorkoutNum(s, 1, 'leangains')).toEqual({ week: 1, offset: 0 });
    expect(workoutKeyForWorkoutNum(s, 2, 'leangains')).toEqual({ week: 1, offset: 2 });
    expect(workoutKeyForWorkoutNum(s, 3, 'leangains')).toEqual({ week: 2, offset: 0 }); // week-2 day
    expect(workoutKeyForWorkoutNum(s, 24, 'leangains')).toEqual({ week: 12, offset: 2 });
  });

  it('returns undefined past the full canonical length', () => {
    const s = [spec(0, 'Bench Press', 1), spec(2, 'Squat', 1)];
    expect(workoutKeyForWorkoutNum(s, 25, 'leangains')).toBeUndefined();
  });

  it('weekForWorkoutNum is exactly its .week projection', () => {
    const s = [spec(0, 'Squat', 1), spec(3, 'Deadlift', 1), spec(0, 'Squat', 2), spec(3, 'Deadlift', 2)];
    for (const n of [1, 2, 3, 4, 5]) {
      expect(weekForWorkoutNum(s, n)).toBe(workoutKeyForWorkoutNum(s, n)?.week);
    }
  });
});

describe('applyLiftOverrides', () => {
  const lifts = ['Squat', 'Bench Press', 'Deadlift'];

  it('returns spec lifts unchanged when no overrides', () => {
    expect(applyLiftOverrides(lifts, [])).toEqual(lifts);
  });

  it('remove — drops the target lift', () => {
    const o: LiftOverride[] = [{ lift: 'Bench Press', action: 'remove' }];
    expect(applyLiftOverrides(lifts, o)).toEqual(['Squat', 'Deadlift']);
  });

  it('remove — no-op when lift is not in list', () => {
    const o: LiftOverride[] = [{ lift: 'Overhead Press', action: 'remove' }];
    expect(applyLiftOverrides(lifts, o)).toEqual(lifts);
  });

  it('replace — swaps in-place preserving order', () => {
    const o: LiftOverride[] = [{ lift: 'Bench Press', action: 'replace', replacedBy: 'Dips' }];
    expect(applyLiftOverrides(lifts, o)).toEqual(['Squat', 'Dips', 'Deadlift']);
  });

  it('replace without replacedBy — no-op (invalid but defensively handled)', () => {
    const o: LiftOverride[] = [{ lift: 'Bench Press', action: 'replace' }];
    expect(applyLiftOverrides(lifts, o)).toEqual(lifts);
  });

  it('add — appends new lift', () => {
    const o: LiftOverride[] = [{ lift: 'Chin-up', action: 'add' }];
    expect(applyLiftOverrides(lifts, o)).toEqual([...lifts, 'Chin-up']);
  });

  it('add — no-op when lift already present', () => {
    const o: LiftOverride[] = [{ lift: 'Squat', action: 'add' }];
    expect(applyLiftOverrides(lifts, o)).toEqual(lifts);
  });

  it('combined — remove, replace, add applied in order', () => {
    const o: LiftOverride[] = [
      { lift: 'Squat', action: 'remove' },
      { lift: 'Bench Press', action: 'replace', replacedBy: 'Dips' },
      { lift: 'Chin-up', action: 'add' },
    ];
    expect(applyLiftOverrides(lifts, o)).toEqual(['Dips', 'Deadlift', 'Chin-up']);
  });
});

describe('toWorkoutResponse with plannedLifts', () => {
  const program = '5-3-1';
  const cycleNum = 1;
  const workoutNum = 1;
  const week = 1;

  const record = (lift: string, setNum: number, weight: number) => ({
    program,
    cycleNum,
    workoutNum,
    date: new Date('2026-05-07T00:00:00Z'),
    lift,
    setNum,
    weight,
    reps: 5,
    notes: '',
  });

  it('marks logged lifts as planned:false', () => {
    const records = [record('Squat', 1, 200)];
    const result = toWorkoutResponse(program, cycleNum, workoutNum, week, records, { plannedLifts: ['Squat'] });
    expect(result.lifts[0]).toMatchObject({ lift: 'Squat', planned: false });
    expect(result.lifts[0]?.sets).toHaveLength(1);
  });

  it('marks unlogged planned lifts as planned:true with empty sets', () => {
    const result = toWorkoutResponse(program, cycleNum, workoutNum, week, [], { plannedLifts: ['Squat', 'Bench Press'] });
    expect(result.lifts).toHaveLength(2);
    expect(result.lifts[0]).toMatchObject({ lift: 'Squat', sets: [], planned: true });
    expect(result.lifts[1]).toMatchObject({ lift: 'Bench Press', sets: [], planned: true });
  });

  it('appends logged lifts not in planned list as planned:false', () => {
    const records = [record('Squat', 1, 200), record('Chin-up', 1, 0)];
    const result = toWorkoutResponse(program, cycleNum, workoutNum, week, records, { plannedLifts: ['Squat'] });
    expect(result.lifts).toHaveLength(2);
    expect(result.lifts[0]).toMatchObject({ lift: 'Squat', planned: false });
    expect(result.lifts[1]).toMatchObject({ lift: 'Chin-up', planned: false });
  });

  it('without plannedLifts — all logged lifts get planned:false (legacy behaviour)', () => {
    const records = [record('Squat', 1, 200)];
    const result = toWorkoutResponse(program, cycleNum, workoutNum, week, records);
    expect(result.lifts[0]).toMatchObject({ lift: 'Squat', planned: false });
  });

  it('uses scheduledDate as date when no records exist', () => {
    const scheduledDate = new Date('2026-06-02T00:00:00.000Z');
    const result = toWorkoutResponse(program, cycleNum, workoutNum, week, [], { scheduledDate });
    expect(result.date).toBe('2026-06-02');
  });

  it('prefers first record date over scheduledDate when records exist', () => {
    const records = [record('Squat', 1, 200)];
    const scheduledDate = new Date('2026-06-02T00:00:00.000Z');
    const result = toWorkoutResponse(program, cycleNum, workoutNum, week, records, { scheduledDate });
    expect(result.date).toBe(records[0]!.date.toISOString().slice(0, 10));
  });

  it('no-schedule, unlogged: derives date from cycleStart + (week-1)*7 + offset (issue #745)', () => {
    // No records, no scheduledDate. Pre-#745 this fell back to today(); now it must
    // equal the date the Cycle Dashboard card computes for the same (cycleStart,
    // week, offset) — both route through the shared noScheduleWorkoutDateUTC.
    const cycleStart = new Date('2026-04-20T00:00:00.000Z');
    // week 2, offset 0 → 2026-04-20 + 7 = 2026-04-27 (NOT today).
    const result = toWorkoutResponse(program, cycleNum, 3, 2, [], {
      plannedLifts: ['Squat'],
      cycleStartDate: cycleStart,
      offset: 0,
    });
    expect(result.date).toBe('2026-04-27');
  });

  it('no-schedule week-1 date is cycleStart + offset', () => {
    const cycleStart = new Date('2026-04-20T00:00:00.000Z');
    const result = toWorkoutResponse(program, cycleNum, 2, 1, [], {
      plannedLifts: ['Squat'],
      cycleStartDate: cycleStart,
      offset: 2,
    });
    expect(result.date).toBe('2026-04-22');
  });

  it('scheduledDate still wins over the cycleStart-derived no-schedule date', () => {
    const cycleStart = new Date('2026-04-20T00:00:00.000Z');
    const scheduledDate = new Date('2026-06-02T00:00:00.000Z');
    const result = toWorkoutResponse(program, cycleNum, 3, 2, [], {
      plannedLifts: ['Squat'],
      scheduledDate,
      cycleStartDate: cycleStart,
      offset: 0,
    });
    expect(result.date).toBe('2026-06-02');
  });

  it('falls back to today only when cycleStartDate/offset are absent (defensive last resort)', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    try {
      // No records, no scheduledDate, and no cycleStart/offset threaded → retains the
      // pre-#745 today() behavior so a degenerate call (e.g. missing cycle dashboard)
      // never crashes. The controller always threads them in real no-schedule mode.
      const result = toWorkoutResponse(program, cycleNum, workoutNum, week, []);
      expect(result.date).toBe('2026-08-15');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('buildCycleDashboardResponse', () => {
  const baseDashboard: CycleDashboard = {
    program: 'test-531',
    cycleNum: 1,
    cycleDate: new Date('2026-05-19T00:00:00.000Z'),
    cycleUnit: 'week',
    sheetName: 'Sheet1',
    cycleStartWeekday: Weekday.Monday,
  };

  const WEEK_TYPE = 'training' as const;

  const sw = (workoutNum: number, weekNum: number, date: string): ScheduledWorkout => ({
    workoutNum,
    weekNum,
    scheduledDate: new Date(`${date}T00:00:00.000Z`),
  });

  it('returns base response when scheduled array is empty', () => {
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, [], new Map(), new Set());
    expect(result.weeks).toEqual([]);
  });

  it('emits workouts[] with workoutNum and date per entry', () => {
    const scheduled = [sw(1, 1, '2026-05-19'), sw(2, 1, '2026-05-21'), sw(3, 2, '2026-05-26')];
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, new Map(), new Set());
    expect(result.weeks).toHaveLength(2);
    const week1 = result.weeks[0]!;
    expect(week1.week).toBe(1);
    expect(week1.workouts).toHaveLength(2);
    expect(week1.workouts[0]).toEqual({ workoutNum: 1, date: '2026-05-19', skipped: false });
    expect(week1.workouts[1]).toEqual({ workoutNum: 2, date: '2026-05-21', skipped: false });
    expect(week1.completed).toBe(false);
    const week2 = result.weeks[1]!;
    expect(week2.workouts[0]).toEqual({ workoutNum: 3, date: '2026-05-26', skipped: false });
  });

  it('applies override date when present', () => {
    const scheduled = [sw(1, 1, '2026-05-19')];
    const overrides = new Map([[1, new Date('2026-05-20T00:00:00.000Z')]]);
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, overrides, new Set());
    expect(result.weeks[0]!.workouts[0]).toEqual({ workoutNum: 1, date: '2026-05-20', skipped: false });
  });

  it('marks week completed when all workouts have records', () => {
    const scheduled = [sw(1, 1, '2026-05-19'), sw(2, 1, '2026-05-21')];
    const completed = new Set([1, 2]);
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, new Map(), completed);
    expect(result.weeks[0]!.completed).toBe(true);
  });

  it('week is incomplete when only some workouts have records', () => {
    const scheduled = [sw(1, 1, '2026-05-19'), sw(2, 1, '2026-05-21')];
    const completed = new Set([1]);
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, new Map(), completed);
    expect(result.weeks[0]!.completed).toBe(false);
  });

  it('marks skipped workout as skipped:true in output', () => {
    const scheduled = [sw(1, 1, '2026-05-19'), sw(2, 1, '2026-05-21')];
    const skipped = new Set([1]);
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, new Map(), new Set(), skipped);
    expect(result.weeks[0]!.workouts[0]!.skipped).toBe(true);
    expect(result.weeks[0]!.workouts[1]!.skipped).toBe(false);
  });

  it('week is completed when all workouts are either logged or skipped', () => {
    const scheduled = [sw(1, 1, '2026-05-19'), sw(2, 1, '2026-05-21')];
    const completed = new Set([1]);
    const skipped = new Set([2]);
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, new Map(), completed, skipped);
    expect(result.weeks[0]!.completed).toBe(true);
  });

  it('week is incomplete when a skipped workout still has an un-logged sibling', () => {
    const scheduled = [sw(1, 1, '2026-05-19'), sw(2, 1, '2026-05-21'), sw(3, 1, '2026-05-23')];
    const skipped = new Set([1]);
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, new Map(), new Set(), skipped);
    expect(result.weeks[0]!.completed).toBe(false);
  });

  it('surfaces per-workout metadata top-level in no-schedule mode (issue #740)', () => {
    const overrides = new Map([[2, new Date('2026-05-22T00:00:00.000Z')]]);
    const result = buildCycleDashboardResponse(
      baseDashboard,
      WEEK_TYPE,
      [], // no schedule → weeks: []
      overrides,
      new Set([1]), // completed
      new Set([3]), // skipped
    );
    expect(result.weeks).toEqual([]);
    expect(result.dateOverrides).toEqual({ 2: '2026-05-22' });
    expect(result.completedWorkoutNums).toEqual([1]);
    expect(result.skippedWorkoutNums).toEqual([3]);
  });

  it('surfaces the same top-level metadata in schedule mode', () => {
    const scheduled = [sw(1, 1, '2026-05-19'), sw(2, 1, '2026-05-21')];
    const overrides = new Map([[1, new Date('2026-05-20T00:00:00.000Z')]]);
    const result = buildCycleDashboardResponse(baseDashboard, WEEK_TYPE, scheduled, overrides, new Set([1]), new Set());
    expect(result.weeks).toHaveLength(1);
    expect(result.dateOverrides).toEqual({ 1: '2026-05-20' });
    expect(result.completedWorkoutNums).toEqual([1]);
    expect(result.skippedWorkoutNums).toEqual([]);
  });
});
