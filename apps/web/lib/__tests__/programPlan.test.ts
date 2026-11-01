import type { MacrocycleWeekSummary, LiftingProgramSpecResponse } from '@lifting-logbook/types';
import type { ProgramLengthMeta } from '@lifting-logbook/core';
import {
  deriveProgramPhases,
  deriveProgramSummary,
  estimateCompletionDate,
  resolveProgramPlanMeta,
  type PhaseDashboard,
} from '../programPlan';

const makeWeek = (
  week: number,
  dates: string[],
  completed: boolean,
): MacrocycleWeekSummary => ({
  week,
  workouts: dates.map((date, i) => ({ workoutNum: i + 1, date, skipped: false })),
  completed,
});

const makeSpec = (
  overrides: Partial<LiftingProgramSpecResponse>,
): LiftingProgramSpecResponse => ({
  week: 1,
  lift: 'Squat',
  order: 1,
  offset: 0,
  increment: 5,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0,
  activation: '',
  ...overrides,
});

// Leangains/RPT-shaped (autoregulated, repeating block) and 5-3-1-shaped (mesocycle).
const REPEATING_12: ProgramLengthMeta = { lengthWeeks: 12, mesocycleWeeks: 1, phaseStyle: 'repeating' };
const REPEATING_8: ProgramLengthMeta = { lengthWeeks: 8, mesocycleWeeks: 1, phaseStyle: 'repeating' };
const MESO_12: ProgramLengthMeta = { lengthWeeks: 12, mesocycleWeeks: 3, phaseStyle: 'mesocycle' };

// One workout a week for `n` weeks, on its spec-relative date from a 2026-01-01
// start: week 1 is 2026-01-01, week 2 2026-01-08, week 4 2026-01-22.
const weeklyDays = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    workoutNum: i + 1,
    week: i + 1,
    date: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString().slice(0, 10),
  }));

// With no schedule, `weeks` is empty (#1036).
const noSchedule = (overrides: Partial<PhaseDashboard> = {}): PhaseDashboard => ({
  weeks: [],
  dateOverrides: {},
  completedWorkoutNums: [],
  skippedWorkoutNums: [],
  ...overrides,
});

// With a schedule, `weeks` lists every workout on its scheduled date (#1023).
const withSchedule = (
  days: ReturnType<typeof weeklyDays>,
  scheduled: (workoutNum: number) => string,
  overrides: Partial<PhaseDashboard> = {},
): PhaseDashboard => {
  const base = noSchedule(overrides);
  const done = new Set([...base.completedWorkoutNums, ...base.skippedWorkoutNums]);
  const weeks = [...new Set(days.map((d) => d.week))].map((week) => {
    const inWeek = days.filter((d) => d.week === week);
    return {
      week,
      workouts: inWeek.map((d) => ({
        workoutNum: d.workoutNum,
        date: scheduled(d.workoutNum),
        skipped: base.skippedWorkoutNums.includes(d.workoutNum),
      })),
      completed: inWeek.every((d) => done.has(d.workoutNum)),
    };
  });
  return { ...base, weeks };
};

// ---------------------------------------------------------------------------
// resolveProgramPlanMeta
// ---------------------------------------------------------------------------

describe('resolveProgramPlanMeta', () => {
  it('resolves registered built-ins from the canonical registry', () => {
    expect(resolveProgramPlanMeta('leangains', [])).toEqual(REPEATING_12);
    expect(resolveProgramPlanMeta('rpt', [])).toEqual(REPEATING_8);
    expect(resolveProgramPlanMeta('5-3-1', [])).toEqual(MESO_12);
  });

  it('falls back to a flat block of the spec length for unregistered programs', () => {
    const specs = [makeSpec({ week: 1 }), makeSpec({ week: 2 }), makeSpec({ week: 3 })];
    expect(resolveProgramPlanMeta('custom-uuid', specs)).toEqual({
      lengthWeeks: 3,
      mesocycleWeeks: 3,
      phaseStyle: 'repeating',
    });
  });
});

// ---------------------------------------------------------------------------
// deriveProgramPhases — repeating (Leangains / RPT)
// ---------------------------------------------------------------------------

describe('deriveProgramPhases — repeating programs', () => {
  const BEFORE_START = '2025-12-01';

  it('renders a single flat Training phase spanning the whole program', () => {
    const phases = deriveProgramPhases(weeklyDays(12), noSchedule(), BEFORE_START, REPEATING_12);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({
      name: 'Training',
      startWeek: 1,
      endWeek: 12,
      type: 'training',
    });
  });

  it('never fabricates a Test or Deload phase (issue #680)', () => {
    const phases = deriveProgramPhases(weeklyDays(12), noSchedule(), BEFORE_START, REPEATING_12);
    expect(phases.every((p) => p.type === 'training')).toBe(true);
    expect(phases.some((p) => p.name === 'Test')).toBe(false);
  });

  it('spans the program length for an 8-week program', () => {
    const phases = deriveProgramPhases(weeklyDays(8), noSchedule(), BEFORE_START, REPEATING_8);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ startWeek: 1, endWeek: 8, type: 'training' });
  });
});

// ---------------------------------------------------------------------------
// deriveProgramPhases — mesocycle (5/3/1)
// ---------------------------------------------------------------------------

describe('deriveProgramPhases — mesocycle programs', () => {
  const BEFORE_START = '2025-12-01';

  it('renders one training phase per mesocycle with correct week ranges', () => {
    const phases = deriveProgramPhases(weeklyDays(12), noSchedule(), BEFORE_START, MESO_12);
    expect(phases.map((p) => [p.name, p.startWeek, p.endWeek])).toEqual([
      ['Mesocycle 1', 1, 3],
      ['Mesocycle 2', 4, 6],
      ['Mesocycle 3', 7, 9],
      ['Mesocycle 4', 10, 12],
    ]);
  });

  it('keeps every mesocycle a training phase — no fabricated Test week', () => {
    const phases = deriveProgramPhases(weeklyDays(12), noSchedule(), BEFORE_START, MESO_12);
    expect(phases.every((p) => p.type === 'training')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveProgramPhases — status
// ---------------------------------------------------------------------------

describe('deriveProgramPhases — status with no schedule (issue #1036)', () => {
  const days = weeklyDays(12);

  it('marks a mesocycle completed once every workout in it is logged or skipped', () => {
    const dashboard = noSchedule({ completedWorkoutNums: [1, 2], skippedWorkoutNums: [3] });
    const phases = deriveProgramPhases(days, dashboard, '2026-01-16', MESO_12);
    expect(phases[0]?.status).toBe('completed'); // Mesocycle 1 (weeks 1-3)
    expect(phases[1]?.status).toBe('upcoming'); // Mesocycle 2 (weeks 4-6), first workout 2026-01-22
  });

  it('marks a mesocycle in progress once a workout in it is dated today or earlier', () => {
    // Week 2's workout is dated today; week 3's is not yet logged.
    const dashboard = noSchedule({ completedWorkoutNums: [1] });
    const phases = deriveProgramPhases(days, dashboard, '2026-01-08', MESO_12);
    expect(phases[0]?.status).toBe('in-progress');
    expect(phases[1]?.status).toBe('upcoming');
  });

  it('dates a rescheduled workout by its override', () => {
    // Week 4's workout, normally 2026-01-22, moved before today.
    const dashboard = noSchedule({ dateOverrides: { 4: '2026-01-10' } });
    const phases = deriveProgramPhases(days, dashboard, '2026-01-12', MESO_12);
    expect(phases[1]?.status).toBe('in-progress');
  });

  it('marks every phase upcoming before the first workout', () => {
    const phases = deriveProgramPhases(days, noSchedule(), '2025-12-31', MESO_12);
    expect(phases.every((p) => p.status === 'upcoming')).toBe(true);
  });
});

describe('deriveProgramPhases — status with a schedule', () => {
  const days = weeklyDays(12);
  // Every other day from the start, so week 4's workout falls on 2026-01-07,
  // not its spec-relative 2026-01-22: the schedule sets the pace (#1023).
  const everyOtherDay = (workoutNum: number) =>
    new Date(Date.UTC(2026, 0, 1 + (workoutNum - 1) * 2)).toISOString().slice(0, 10);

  it('marks a mesocycle completed once every workout in it is logged or skipped', () => {
    const dashboard = withSchedule(days, everyOtherDay, {
      completedWorkoutNums: [1, 3],
      skippedWorkoutNums: [2],
    });
    const phases = deriveProgramPhases(days, dashboard, '2026-01-06', MESO_12);
    expect(phases[0]?.status).toBe('completed');
    expect(phases[1]?.status).toBe('upcoming');
  });

  it('dates workouts by the schedule, not their spec-relative dates', () => {
    const dashboard = withSchedule(days, everyOtherDay, { completedWorkoutNums: [1, 2, 3] });
    const phases = deriveProgramPhases(days, dashboard, '2026-01-08', MESO_12);
    expect(phases[0]?.status).toBe('completed');
    expect(phases[1]?.status).toBe('in-progress'); // workout 4 scheduled 2026-01-07
    expect(phases[2]?.status).toBe('upcoming'); // workout 7 scheduled 2026-01-13
  });

  it('marks every phase upcoming when no scheduled date has passed', () => {
    const dashboard = withSchedule(days, () => '2099-01-01');
    const phases = deriveProgramPhases(days, dashboard, '2026-06-01', REPEATING_12);
    expect(phases.every((p) => p.status === 'upcoming')).toBe(true);
  });

  it('shows the full-length plan as upcoming for a pre-#680 macrocycle with only week 1 scheduled', () => {
    // Storage predates full-length expansion: only week 1 exists in the dashboard,
    // but the plan still renders the canonical 12-week overview (weeks 2-12 upcoming).
    const dashboard = noSchedule({ weeks: [makeWeek(1, ['2099-01-01'], false)] });
    const phases = deriveProgramPhases(days, dashboard, '2025-12-01', REPEATING_12);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ startWeek: 1, endWeek: 12, status: 'upcoming' });
  });
});

// ---------------------------------------------------------------------------
// deriveProgramSummary
// ---------------------------------------------------------------------------

describe('estimateCompletionDate', () => {
  // Workouts 1 and 2 on their spec-relative dates: 5-3-1's first and last days
  // from a Monday 2026-05-18 start (week 12, offset 3 = +80 days).
  const days = [
    { workoutNum: 1, date: '2026-05-18' },
    { workoutNum: 2, date: '2026-08-06' },
  ];
  const START = '2026-05-18';

  it('is the last workout’s date with no schedule', () => {
    expect(estimateCompletionDate(days, { macrocycleStartDate: START, weeks: [], dateOverrides: {} })).toBe(
      '2026-08-06',
    );
  });

  it('is the last scheduled workout’s date with a schedule, whose pace sets the length (issue #1023)', () => {
    // On Mon/Wed/Fri, 5-3-1's last day falls in calendar week 8.
    const weeks = [makeWeek(1, ['2026-05-18', '2026-07-10'], false)];
    expect(estimateCompletionDate(days, { macrocycleStartDate: START, weeks, dateOverrides: {} })).toBe(
      '2026-07-10',
    );
  });

  it('means the same with or without a schedule that dates the days alike', () => {
    // A schedule that puts every workout on its spec-relative day (5-3-1 on
    // Mon/Thu) must not change the estimate. Before #1023's review it did.
    const weeks = [makeWeek(1, ['2026-05-18', '2026-08-06'], false)];
    expect(estimateCompletionDate(days, { macrocycleStartDate: START, weeks, dateOverrides: {} })).toBe(
      estimateCompletionDate(days, { macrocycleStartDate: START, weeks: [], dateOverrides: {} }),
    );
  });

  it('counts a rescheduled workout in both modes', () => {
    const dateOverrides = { 2: '2026-08-20' };
    expect(estimateCompletionDate(days, { macrocycleStartDate: START, weeks: [], dateOverrides })).toBe('2026-08-20');
    const weeks = [makeWeek(1, ['2026-05-18', '2026-07-10'], false)];
    expect(estimateCompletionDate(days, { macrocycleStartDate: START, weeks, dateOverrides })).toBe('2026-08-20');
  });

  it('is the start date for a program with no workouts', () => {
    expect(estimateCompletionDate([], { macrocycleStartDate: START, weeks: [], dateOverrides: {} })).toBe(START);
  });
});

describe('deriveProgramSummary', () => {
  it('uses the canonical program length for duration, not the stored block', () => {
    // A Leangains-shaped 1-week spec must still report its advertised 12 weeks.
    const oneWeekSpecs = [
      makeSpec({ week: 1 }),
      makeSpec({ week: 1, lift: 'Bench Press', offset: 2 }),
    ];
    expect(deriveProgramSummary(oneWeekSpecs, 'leangains').durationWeeks).toBe(12);
  });

  it('falls back to the max spec week for unregistered programs', () => {
    const specs = [makeSpec({ week: 1 }), makeSpec({ week: 12 }), makeSpec({ week: 7 })];
    expect(deriveProgramSummary(specs, 'custom-uuid').durationWeeks).toBe(12);
  });

  it('counts unique offsets in week 1 for frequency', () => {
    const specs = [
      makeSpec({ week: 1, offset: 0 }),
      makeSpec({ week: 1, offset: 2, lift: 'Bench Press' }),
      makeSpec({ week: 1, offset: 4, lift: 'Deadlift' }),
      makeSpec({ week: 2, offset: 0 }),
    ];
    expect(deriveProgramSummary(specs, 'custom').frequency).toBe(3);
  });

  it('returns unique exercise names preserving insertion order', () => {
    const specs = [
      makeSpec({ lift: 'Squat', week: 1 }),
      makeSpec({ lift: 'Bench Press', week: 1 }),
      makeSpec({ lift: 'Squat', week: 2 }),
      makeSpec({ lift: 'Deadlift', week: 1 }),
    ];
    expect(deriveProgramSummary(specs, 'custom').exercises).toEqual([
      'Squat',
      'Bench Press',
      'Deadlift',
    ]);
  });

  it('derives warmUpSets from comma-separated warmUpPct on first week-1 spec', () => {
    const specs = [makeSpec({ week: 1, warmUpPct: '0.4,0.5,0.6' })];
    expect(deriveProgramSummary(specs, 'custom').warmUpSets).toBe(3);
  });

  it('returns 0 warmUpSets when warmUpPct is empty', () => {
    const specs = [makeSpec({ week: 1, warmUpPct: '' })];
    expect(deriveProgramSummary(specs, 'custom').warmUpSets).toBe(0);
  });

  it('returns 0 warmUpSets when warmUpPct is null (API omits field)', () => {
    const specs = [makeSpec({ week: 1, warmUpPct: null as unknown as string })];
    expect(deriveProgramSummary(specs, 'custom').warmUpSets).toBe(0);
  });

  it('returns working sets from first week-1 spec sets field', () => {
    const specs = [makeSpec({ week: 1, sets: 5 })];
    expect(deriveProgramSummary(specs, 'custom').workingSets).toBe(5);
  });
});
