import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { LiftData } from './types';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
  fetchLatestBodyWeight: jest.fn().mockResolvedValue(null),
  // Not imported by the page any more (issue #978); kept on the mock so the
  // assertion below can prove the whole-macrocycle refetch is gone rather than
  // merely unmocked.
  fetchLiftRecords: jest.fn(),
  // No active focus block unless a test says otherwise.
  fetchFocusPlan: jest.fn().mockResolvedValue({ groups: [] }),
}));

jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));

jest.mock('@/lib/userToday', () => ({
  getUserToday: jest.fn().mockResolvedValue('2026-10-30'),
}));

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

// The logger is the one child whose props this test cares about. Echo them.
jest.mock('./WorkoutLogger', () => ({
  __esModule: true,
  default: ({ lifts, isReadOnly }: { lifts: LiftData[]; isReadOnly: boolean }) => (
    <div data-lifts={JSON.stringify(lifts)} data-readonly={String(isReadOnly)} />
  ),
}));

import { emptyFocusDayState } from '@lifting-logbook/types';
import {
  fetchWorkout,
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchLiftRecords,
  fetchFocusPlan,
} from '@/lib/api';
import { focusPlan, planGroup, planItem } from '@/lib/__tests__/focusPlanFixture';
import WorkoutLoggingPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedSpec = fetchProgramSpec as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedLiftRecords = fetchLiftRecords as unknown as jest.Mock;
const mockedFocusPlan = fetchFocusPlan as unknown as jest.Mock;

function spec(lift: string) {
  return {
    week: 1,
    lift,
    order: 1,
    offset: 0,
    increment: 5,
    sets: 1,
    reps: 5,
    amrap: false,
    warmUpPct: '40,50,60',
    wtDecrementPct: 0,
    activation: '',
  };
}

const LOGGED_SET = { id: '5-3-1-1-1-20260106-Squat-1', setNum: 1, weight: 200, reps: 5, amrap: false, notes: 'belt' };

// `sets` is loosely typed on purpose: one case feeds a planned lift id-less,
// spec-shaped sets, which the real API never sends.
function seedWorkout(
  lifts: { lift: string; planned: boolean; sets: Record<string, unknown>[] }[],
  { skipped = false, specOverrides = {} }: { skipped?: boolean; specOverrides?: Partial<ReturnType<typeof spec>> } = {},
) {
  mockedWorkout.mockResolvedValue({
    program: '5-3-1',
    macrocycleNum: 1,
    workoutNum: 1,
    week: 1,
    date: '2026-01-06',
    skipped,
    lifts,
  });
  mockedSpec.mockResolvedValue(lifts.map((l) => ({ ...spec(l.lift), ...specOverrides })));
  mockedMaxes.mockResolvedValue(lifts.map((l) => ({ lift: l.lift, weight: 200 })));
}

async function renderPage(): Promise<{ lifts: LiftData[]; readOnly: boolean }> {
  const element = (await WorkoutLoggingPage({
    params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1' }),
  })) as ReactElement;
  const html = renderToStaticMarkup(element);
  const encoded = html.match(/data-lifts="([^"]*)"/)?.[1];
  if (encoded === undefined) throw new Error('data-lifts attribute not found in rendered output');
  const readOnly = html.match(/data-readonly="([^"]*)"/)?.[1] === 'true';
  return { lifts: JSON.parse(encoded.replace(/&quot;/g, '"')), readOnly };
}

describe('WorkoutLoggingPage — logged sets come from the workout itself (issue #978)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('pre-populates a logged lift’s sets with the record id, weight, reps and notes', async () => {
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET] }]);

    const { lifts, readOnly } = await renderPage();

    expect(lifts[0]?.workingSets[0]?.existing).toEqual({
      id: '5-3-1-1-1-20260106-Squat-1',
      weight: 200,
      reps: 5,
      notes: 'belt',
    });
    // Every working set is logged, so the page is read-only.
    expect(readOnly).toBe(true);
  });

  it('leaves a planned lift’s sets unlogged, even when the response carries spec-shaped sets', async () => {
    // The real API sends `planned: true` lifts with no sets; a planned lift is
    // never logged, whatever the response carries.
    seedWorkout([{ lift: 'Squat', planned: true, sets: [{ setNum: 1, weight: 200, reps: 5, amrap: false }] }]);

    const { lifts, readOnly } = await renderPage();

    expect(lifts[0]?.workingSets).toHaveLength(1);
    expect(lifts[0]?.workingSets[0]?.existing).toBeUndefined();
    expect(readOnly).toBe(false);
  });

  it('no longer fetches the macrocycle’s lift records to recover set ids', async () => {
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET] }]);

    await renderPage();

    expect(mockedLiftRecords).not.toHaveBeenCalled();
    expect(mockedWorkout).toHaveBeenCalledWith('5-3-1', 1);
  });
});

describe('WorkoutLoggingPage — working sets come from the plan (issue #1080)', () => {
  // The real API's shapes (`toWorkoutResponse`): an unlogged planned lift has
  // `sets: []`, and a partly logged lift carries only the sets logged so far.
  const THREE_SETS = { sets: 3, reps: 5, amrap: true };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists an unlogged planned lift’s working sets from the plan', async () => {
    seedWorkout([{ lift: 'Squat', planned: true, sets: [] }], { specOverrides: THREE_SETS });

    const { lifts, readOnly } = await renderPage();

    expect(lifts[0]?.workingSets).toEqual([
      { setNum: 1, totalLoad: 200, reps: 5, amrap: false },
      { setNum: 2, totalLoad: 200, reps: 5, amrap: false },
      { setNum: 3, totalLoad: 200, reps: 5, amrap: true },
    ]);
    expect(readOnly).toBe(false);
  });

  it('keeps the planned sets still to do on a partly logged lift', async () => {
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET] }], { specOverrides: THREE_SETS });

    const { lifts, readOnly } = await renderPage();

    expect(lifts[0]?.workingSets.map((s) => [s.setNum, s.existing?.id])).toEqual([
      [1, LOGGED_SET.id],
      [2, undefined],
      [3, undefined],
    ]);
    expect(readOnly).toBe(false);
  });

  it('is not read-only while another lift still has planned sets to log', async () => {
    seedWorkout([
      { lift: 'Squat', planned: false, sets: [LOGGED_SET] },
      { lift: 'Deadlift', planned: true, sets: [] },
    ]);

    const { lifts, readOnly } = await renderPage();

    expect(lifts[1]?.workingSets).toHaveLength(1);
    expect(readOnly).toBe(false);
  });

  it('keeps a logged set the plan has no slot for', async () => {
    const extra = { ...LOGGED_SET, id: 'extra', setNum: 2, weight: 180, reps: 8 };
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET, extra] }]);

    const { lifts, readOnly } = await renderPage();

    expect(lifts[0]?.workingSets.map((s) => [s.setNum, s.totalLoad, s.existing?.id])).toEqual([
      [1, 200, LOGGED_SET.id],
      [2, 180, 'extra'],
    ]);
    expect(readOnly).toBe(true);
  });
});

describe('WorkoutLoggingPage — warm-ups resolve through the workout’s day (issue #1014)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Week 2, day 0 of a 1-week repeating block (Leangains-shaped). The spec
  // endpoint serves only the stored block, so its rows all say week 1. Squat
  // also trains on day 2 with a single warm-up, listed first, so a lookup that
  // ignored the workout's day would find that row instead.
  function seedWeekTwo(
    lifts: { lift: string; replaces?: string }[],
    maxes: { lift: string; weight: number }[],
  ) {
    mockedWorkout.mockResolvedValue({
      program: 'leangains',
      macrocycleNum: 1,
      workoutNum: 4,
      week: 2,
      offset: 0,
      date: '2026-01-13',
      skipped: false,
      lifts: lifts.map((l) => ({ ...l, planned: true, sets: [] })),
    });
    mockedSpec.mockResolvedValue([
      { ...spec('Squat'), offset: 2, warmUpPct: '0.5' },
      { ...spec('Squat'), warmUpPct: '0.4,0.5,0.6' },
    ]);
    mockedMaxes.mockResolvedValue(maxes);
  }

  it('plans warm-ups for a week-2 workout of a repeating 1-week block', async () => {
    // Pre-#1014 the page matched `s.week === workout.week` against the stored
    // block, found nothing from week 2 on, and showed no warm-ups.
    seedWeekTwo([{ lift: 'Squat' }], [{ lift: 'Squat', weight: 200 }]);

    const { lifts } = await renderPage();

    expect(lifts[0]?.warmUpSets).toEqual([
      { reps: 5, totalLoad: 80 },
      { reps: 4, totalLoad: 100 },
      { reps: 3, totalLoad: 120 },
    ]);
  });

  it('gives a replacement the warm-ups of the slot it replaced, priced from its own training max', async () => {
    seedWeekTwo(
      [{ lift: 'Front Squat', replaces: 'Squat' }],
      [
        { lift: 'Squat', weight: 300 },
        { lift: 'Front Squat', weight: 200 },
      ],
    );

    const { lifts } = await renderPage();

    expect(lifts[0]?.lift).toBe('Front Squat');
    expect(lifts[0]?.warmUpSets.map((s) => s.totalLoad)).toEqual([80, 100, 120]);
  });
});

describe('WorkoutLoggingPage — focus work (#1060)', () => {
  const PLANNED = { lift: 'Squat', planned: true, sets: [] };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function loggedRaise(setNum: number) {
    return { id: `raise-${setNum}`, setNum, weight: 25, reps: 12, amrap: false, notes: '' };
  }

  it('lists the day’s focus lifts after the planned lifts, prescribed from their focus block', async () => {
    seedWorkout([PLANNED]);
    mockedFocusPlan.mockResolvedValueOnce(focusPlan());

    const { lifts, readOnly } = await renderPage();

    expect(lifts.map((l) => l.lift)).toEqual(['Squat', 'Lateral Raise', 'Face Pull']);
    expect(lifts[1]).toEqual({
      lift: 'Lateral Raise',
      isBodyweightComponent: false,
      warmUpSets: [],
      workingSets: [1, 2, 3].map((setNum) => ({ setNum, totalLoad: 25, reps: 12, amrap: false })),
      focus: { area: 'Shoulders', summary: '3 × 10–12' },
    });
    expect(readOnly).toBe(false);
    expect(mockedFocusPlan).toHaveBeenCalledWith('5-3-1', 1, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('follows the day’s placement', async () => {
    seedWorkout([PLANNED]);
    mockedFocusPlan.mockResolvedValueOnce(focusPlan({ dayState: { ...emptyFocusDayState(), placement: 'before' } }));

    const { lifts } = await renderPage();

    expect(lifts.map((l) => l.lift)).toEqual(['Lateral Raise', 'Face Pull', 'Squat']);
  });

  it('folds a focus lift’s logged sets back into it, once, with the sets still to do', async () => {
    // A logged focus set comes back on the workout as an extra lift not in the plan.
    seedWorkout([PLANNED, { lift: 'Lateral Raise', planned: false, sets: [loggedRaise(1)] }]);
    mockedFocusPlan.mockResolvedValueOnce(focusPlan());

    const { lifts } = await renderPage();

    expect(lifts.map((l) => l.lift)).toEqual(['Squat', 'Lateral Raise', 'Face Pull']);
    expect(lifts[1]?.workingSets.map((s) => s.existing?.id)).toEqual(['raise-1', undefined, undefined]);
  });

  it('keeps offering focus work once it is under way, even with every planned set logged', async () => {
    seedWorkout([
      { lift: 'Squat', planned: false, sets: [LOGGED_SET] },
      { lift: 'Lateral Raise', planned: false, sets: [loggedRaise(1)] },
    ]);
    mockedFocusPlan.mockResolvedValueOnce(focusPlan({ groups: [planGroup({ items: [planItem('Lateral Raise', 2)] })] }));

    const { lifts, readOnly } = await renderPage();

    expect(lifts.map((l) => [l.lift, l.workingSets.length])).toEqual([
      ['Squat', 1],
      ['Lateral Raise', 2],
    ]);
    expect(readOnly).toBe(false);
  });

  it('keeps offering focus work on the workout’s own day after its planned sets are logged', async () => {
    // The usual order with focus work placed after: every planned set, then focus work.
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET] }]);
    mockedFocusPlan.mockResolvedValueOnce(focusPlan({ today: '2026-01-06' }));

    const { lifts, readOnly } = await renderPage();

    expect(lifts.map((l) => l.lift)).toEqual(['Squat', 'Lateral Raise', 'Face Pull']);
    expect(readOnly).toBe(false);
  });

  it('offers no focus work on a skipped workout', async () => {
    seedWorkout([PLANNED], { skipped: true });
    mockedFocusPlan.mockResolvedValueOnce(focusPlan());

    const { lifts } = await renderPage();

    expect(lifts.map((l) => l.lift)).toEqual(['Squat']);
  });

  it('leaves an older workout, logged on its own day, as it was', async () => {
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET] }]);
    mockedFocusPlan.mockResolvedValueOnce(focusPlan());

    const { lifts, readOnly } = await renderPage();

    expect(lifts.map((l) => l.lift)).toEqual(['Squat']);
    expect(readOnly).toBe(true);
  });

  it('skips a focus lift the workout already lists, so the two never share records', async () => {
    seedWorkout([{ lift: 'Face Pull', planned: true, sets: [] }]);
    mockedFocusPlan.mockResolvedValueOnce(focusPlan({ plannedLifts: ['Face Pull'] }));

    const { lifts } = await renderPage();

    expect(lifts.map((l) => [l.lift, l.focus?.area])).toEqual([
      ['Face Pull', undefined],
      ['Lateral Raise', 'Shoulders'],
    ]);
  });

  it('logs the planned lifts alone when the focus plan fails to load', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    seedWorkout([PLANNED]);
    mockedFocusPlan.mockRejectedValueOnce(new Error('API down'));

    const { lifts } = await renderPage();

    expect(lifts.map((l) => l.lift)).toEqual(['Squat']);
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutLoggingPage] focus plan fetch failed, showing planned lifts only',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
