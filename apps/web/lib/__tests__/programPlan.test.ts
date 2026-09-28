import type { CycleWeekSummary, LiftingProgramSpecResponse } from '@lifting-logbook/types';
import type { ProgramLengthMeta } from '@lifting-logbook/core';
import {
  deriveProgramPhases,
  deriveProgramSummary,
  estimateCompletionDate,
  resolveProgramPlanMeta,
} from '../programPlan';

const makeWeek = (
  week: number,
  dates: string[],
  completed: boolean,
): CycleWeekSummary => ({
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

// Leangains/RPT-shaped (autoregulated, repeating block) and 5-3-1-shaped (wave).
const REPEATING_12: ProgramLengthMeta = { lengthWeeks: 12, blockWeeks: 1, phaseStyle: 'repeating' };
const REPEATING_8: ProgramLengthMeta = { lengthWeeks: 8, blockWeeks: 1, phaseStyle: 'repeating' };
const WAVE_12: ProgramLengthMeta = { lengthWeeks: 12, blockWeeks: 3, phaseStyle: 'wave' };

// ---------------------------------------------------------------------------
// resolveProgramPlanMeta
// ---------------------------------------------------------------------------

describe('resolveProgramPlanMeta', () => {
  it('resolves registered built-ins from the canonical registry', () => {
    expect(resolveProgramPlanMeta('leangains', [])).toEqual(REPEATING_12);
    expect(resolveProgramPlanMeta('rpt', [])).toEqual(REPEATING_8);
    expect(resolveProgramPlanMeta('5-3-1', [])).toEqual(WAVE_12);
  });

  it('falls back to a flat block of the spec length for unregistered programs', () => {
    const specs = [makeSpec({ week: 1 }), makeSpec({ week: 2 }), makeSpec({ week: 3 })];
    expect(resolveProgramPlanMeta('custom-uuid', specs)).toEqual({
      lengthWeeks: 3,
      blockWeeks: 3,
      phaseStyle: 'repeating',
    });
  });
});

// ---------------------------------------------------------------------------
// deriveProgramPhases — repeating (Leangains / RPT)
// ---------------------------------------------------------------------------

describe('deriveProgramPhases — repeating programs', () => {
  const futureWeeks12 = Array.from({ length: 12 }, (_, i) =>
    makeWeek(i + 1, ['2099-01-01'], false),
  );

  it('renders a single flat Training phase spanning the whole program', () => {
    const phases = deriveProgramPhases(futureWeeks12, '2026-01-01', REPEATING_12);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({
      name: 'Training',
      startWeek: 1,
      endWeek: 12,
      type: 'training',
    });
  });

  it('never fabricates a Test or Deload phase (issue #680)', () => {
    const phases = deriveProgramPhases(futureWeeks12, '2026-01-01', REPEATING_12);
    expect(phases.every((p) => p.type === 'training')).toBe(true);
    expect(phases.some((p) => p.name === 'Test')).toBe(false);
  });

  it('spans the program length for an 8-week program', () => {
    const weeks8 = Array.from({ length: 8 }, (_, i) => makeWeek(i + 1, ['2099-01-01'], false));
    const phases = deriveProgramPhases(weeks8, '2026-01-01', REPEATING_8);
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ startWeek: 1, endWeek: 8, type: 'training' });
  });
});

// ---------------------------------------------------------------------------
// deriveProgramPhases — wave (5/3/1)
// ---------------------------------------------------------------------------

describe('deriveProgramPhases — wave programs', () => {
  const futureWeeks12 = Array.from({ length: 12 }, (_, i) =>
    makeWeek(i + 1, ['2099-01-01'], false),
  );

  it('renders one training phase per wave with correct week ranges', () => {
    const phases = deriveProgramPhases(futureWeeks12, '2026-01-01', WAVE_12);
    expect(phases.map((p) => [p.name, p.startWeek, p.endWeek])).toEqual([
      ['Wave 1', 1, 3],
      ['Wave 2', 4, 6],
      ['Wave 3', 7, 9],
      ['Wave 4', 10, 12],
    ]);
  });

  it('keeps every wave a training phase — no fabricated Test week', () => {
    const phases = deriveProgramPhases(futureWeeks12, '2026-01-01', WAVE_12);
    expect(phases.every((p) => p.type === 'training')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveProgramPhases — status
// ---------------------------------------------------------------------------

describe('deriveProgramPhases — status', () => {
  it('marks a wave completed only when all its weeks are completed', () => {
    const weeks = [
      makeWeek(1, ['2026-01-01'], true),
      makeWeek(2, ['2026-01-08'], true),
      makeWeek(3, ['2026-01-15'], true),
      ...Array.from({ length: 9 }, (_, i) => makeWeek(i + 4, ['2099-01-01'], false)),
    ];
    const phases = deriveProgramPhases(weeks, '2026-02-01', WAVE_12);
    expect(phases[0]?.status).toBe('completed'); // Wave 1 (weeks 1-3)
    expect(phases[1]?.status).toBe('upcoming'); // Wave 2 (weeks 4-6)
  });

  it('marks a wave in-progress when it has past dates but is not fully completed', () => {
    const weeks = [
      makeWeek(1, ['2026-01-01'], true),
      makeWeek(2, ['2026-01-08'], false),
      makeWeek(3, ['2026-01-15'], false),
      ...Array.from({ length: 9 }, (_, i) => makeWeek(i + 4, ['2099-01-01'], false)),
    ];
    const phases = deriveProgramPhases(weeks, '2026-01-10', WAVE_12);
    expect(phases[0]?.status).toBe('in-progress');
  });

  it('marks all phases upcoming when no workout dates have passed', () => {
    const weeks = Array.from({ length: 12 }, (_, i) => makeWeek(i + 1, ['2099-01-01'], false));
    const phases = deriveProgramPhases(weeks, '2026-01-01', REPEATING_12);
    expect(phases.every((p) => p.status === 'upcoming')).toBe(true);
  });

  it('shows the full-length plan as upcoming for a pre-#680 cycle with only week 1 scheduled', () => {
    // Storage predates full-length expansion: only week 1 exists in the dashboard,
    // but the plan still renders the canonical 12-week overview (weeks 2-12 upcoming).
    const weeks = [makeWeek(1, ['2099-01-01'], false)];
    const phases = deriveProgramPhases(weeks, '2026-01-01', REPEATING_12);
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
    expect(estimateCompletionDate(days, { cycleStartDate: START, weeks: [], dateOverrides: {} })).toBe(
      '2026-08-06',
    );
  });

  it('is the last scheduled workout’s date with a schedule, whose pace sets the length (issue #1023)', () => {
    // On Mon/Wed/Fri, 5-3-1's last day falls in calendar week 8.
    const weeks = [makeWeek(1, ['2026-05-18', '2026-07-10'], false)];
    expect(estimateCompletionDate(days, { cycleStartDate: START, weeks, dateOverrides: {} })).toBe(
      '2026-07-10',
    );
  });

  it('means the same with or without a schedule that dates the days alike', () => {
    // A schedule that puts every workout on its spec-relative day (5-3-1 on
    // Mon/Thu) must not change the estimate. Before #1023's review it did.
    const weeks = [makeWeek(1, ['2026-05-18', '2026-08-06'], false)];
    expect(estimateCompletionDate(days, { cycleStartDate: START, weeks, dateOverrides: {} })).toBe(
      estimateCompletionDate(days, { cycleStartDate: START, weeks: [], dateOverrides: {} }),
    );
  });

  it('counts a rescheduled workout in both modes', () => {
    const dateOverrides = { 2: '2026-08-20' };
    expect(estimateCompletionDate(days, { cycleStartDate: START, weeks: [], dateOverrides })).toBe('2026-08-20');
    const weeks = [makeWeek(1, ['2026-05-18', '2026-07-10'], false)];
    expect(estimateCompletionDate(days, { cycleStartDate: START, weeks, dateOverrides })).toBe('2026-08-20');
  });

  it('is the start date for a program with no workouts', () => {
    expect(estimateCompletionDate([], { cycleStartDate: START, weeks: [], dateOverrides: {} })).toBe(START);
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
