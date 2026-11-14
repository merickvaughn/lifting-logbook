import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { LiftData } from './types';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
  // No modification has a max of its own unless a test says otherwise (#1153).
  fetchModificationMaxes: jest.fn().mockResolvedValue([]),
  fetchLatestBodyWeight: jest.fn().mockResolvedValue(null),
  // Never read: not to recover set ids (issue #978), nor for a `double` lift's last session, which
  // the workout carries (#1252). The assertions below prove both.
  fetchLiftRecords: jest.fn().mockResolvedValue([]),
  // No active focus block unless a test says otherwise.
  fetchFocusPlan: jest.fn().mockResolvedValue({ groups: [] }),
  // No progression settings of the lifter's own unless a test says otherwise, so a lift
  // follows its row, then the catalog's default (#1211).
  fetchCustomLifts: jest.fn().mockResolvedValue([]),
  fetchAllLiftMetadata: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
  getUserSettings: jest.fn().mockResolvedValue({ defaultProgression: null, defaultWeightIncrement: null }),
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
  redirect: jest.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// The logger is the one child whose props this test cares about. Echo them.
jest.mock('./WorkoutLogger', () => ({
  __esModule: true,
  default: ({
    lifts,
    isReadOnly,
    macrocycleId,
    ownMaxes,
  }: {
    lifts: LiftData[];
    isReadOnly: boolean;
    macrocycleId?: string;
    ownMaxes: Record<string, number> | null;
  }) => (
    <div
      data-lifts={JSON.stringify(lifts)}
      data-readonly={String(isReadOnly)}
      data-macrocycle-id={macrocycleId ?? ''}
      data-own-maxes={JSON.stringify(ownMaxes)}
    />
  ),
}));

import { emptyFocusDayState } from '@lifting-logbook/types';
import type { LiftingProgramSpecResponse } from '@lifting-logbook/types';
import { validateTrainingMaxImport, type TrainingMax } from '@lifting-logbook/core';
import {
  fetchWorkout,
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchLiftRecords,
  fetchFocusPlan,
  fetchModificationMaxes,
  fetchAllLiftMetadata,
} from '@/lib/api';
import { getUserSettings } from '@/lib/active-program';
import { getUserToday } from '@/lib/userToday';
import { focusPlan, planGroup, planItem } from '@/lib/__tests__/focusPlanFixture';
import WorkoutLoggingPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedSpec = fetchProgramSpec as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedLiftRecords = fetchLiftRecords as unknown as jest.Mock;
const mockedFocusPlan = fetchFocusPlan as unknown as jest.Mock;
const mockedModificationMaxes = fetchModificationMaxes as unknown as jest.Mock;
const mockedLiftMetadata = fetchAllLiftMetadata as unknown as jest.Mock;
const mockedUserSettings = getUserSettings as unknown as jest.Mock;
const mockedUserToday = getUserToday as unknown as jest.Mock;

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
  lifts: {
    lift: string;
    planned: boolean;
    sets: Record<string, unknown>[];
    occurrence?: number;
    lastSession?: { date: string; reps: number[] };
  }[],
  { skipped = false, specOverrides = {} }: { skipped?: boolean; specOverrides?: Partial<LiftingProgramSpecResponse> } = {},
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

async function renderPage(): Promise<{
  lifts: LiftData[];
  readOnly: boolean;
  ownMaxes: Record<string, number> | null;
}> {
  const element = (await WorkoutLoggingPage({
    params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1' }),
  })) as ReactElement;
  const html = renderToStaticMarkup(element);
  const attr = (name: string) => {
    const encoded = html.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    if (encoded === undefined) throw new Error(`${name} attribute not found in rendered output`);
    return JSON.parse(encoded.replace(/&quot;/g, '"'));
  };
  const readOnly = html.match(/data-readonly="([^"]*)"/)?.[1] === 'true';
  return { lifts: attr('data-lifts'), readOnly, ownMaxes: attr('data-own-maxes') };
}

describe('WorkoutLoggingPage — two records with one set number (#1135)', () => {
  it('shows both, so the record updateMaxes also reads can be seen and edited', async () => {
    // The API keeps the stored-id row as its own lift when its set number is taken.
    seedWorkout([
      { lift: 'Bench Press', planned: false, sets: [{ ...LOGGED_SET, id: 'name-row', weight: 190 }] },
      { lift: 'bench-press', planned: false, sets: [{ ...LOGGED_SET, id: 'id-row', weight: 200 }] },
    ]);
    mockedSpec.mockResolvedValue([spec('Bench Press')]);

    const { lifts } = await renderPage();

    expect(lifts.map((l) => l.workingSets.map((s) => s.existing?.id))).toEqual([['name-row'], ['id-row']]);
  });
});

describe('WorkoutLoggingPage — a training max stored under another spelling (#1118)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function seedBench(maxes: { lift: string; weight: number; dateUpdated: string }[]) {
    seedWorkout([{ lift: 'Bench Press', planned: true, sets: [] }]);
    mockedMaxes.mockResolvedValue(maxes);
  }

  it('computes the plan from a max imported as Bench P.', async () => {
    const rows: TrainingMax[] = [
      { lift: 'Bench P.' as TrainingMax['lift'], weight: 200, dateUpdated: new Date('2025-12-29') },
    ];
    const { valid, errors } = validateTrainingMaxImport(rows);
    expect(errors).toEqual([]);
    seedBench(valid.map((m) => ({ lift: m.lift, weight: m.weight, dateUpdated: '2025-12-29' })));

    const { lifts } = await renderPage();

    expect(lifts[0]?.workingSets[0]?.totalLoad).toBe(200);
  });

  it('computes from the same weight whichever spelling the max is stored under', async () => {
    seedBench([{ lift: 'bench-press', weight: 200, dateUpdated: '2025-12-29' }]);
    const byId = (await renderPage()).lifts[0]?.workingSets;
    seedBench([{ lift: 'Bench Press', weight: 200, dateUpdated: '2025-12-29' }]);
    const byName = (await renderPage()).lifts[0]?.workingSets;

    expect(byId).toEqual(byName);
  });

  it('lets a newly imported max take over from an older one under the program’s name', async () => {
    seedBench([
      { lift: 'Bench Press', weight: 100, dateUpdated: '2025-01-01' },
      { lift: 'bench-press', weight: 200, dateUpdated: '2025-12-29' },
    ]);

    const { lifts } = await renderPage();

    expect(lifts[0]?.workingSets[0]?.totalLoad).toBe(200);
  });
});

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

  it('passes a logged set’s modifications to the logger (#1152)', async () => {
    const modifications = [{ id: 'm-paused', name: 'Paused' }];
    seedWorkout([{ lift: 'Squat', planned: false, sets: [{ ...LOGGED_SET, modifications }] }]);

    const { lifts } = await renderPage();

    expect(lifts[0]?.workingSets[0]?.existing).toEqual(expect.objectContaining({ modifications }));
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

  it('passes each occurrence of a lift planned twice to the logger, logged apart (issue #1027)', async () => {
    seedWorkout([
      { lift: 'Squat', planned: false, sets: [LOGGED_SET] },
      { lift: 'Squat', planned: true, sets: [], occurrence: 1 },
    ]);

    const { lifts, readOnly } = await renderPage();

    expect(lifts.map((l) => [l.lift, l.occurrence, l.workingSets.map((s) => Boolean(s.existing))])).toEqual([
      ['Squat', undefined, [true]],
      ['Squat', 1, [false]],
    ]);
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

describe('WorkoutLoggingPage — a renumbered macrocycle (#1198)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redirects an old URL to the number the workout was read from', async () => {
    seedWorkout([{ lift: 'Squat', planned: true, sets: [] }]);
    mockedWorkout.mockResolvedValue({ ...(await mockedWorkout()), macrocycleNum: 2, macrocycleId: 'mc-a' });

    await expect(renderPage()).rejects.toThrow('REDIRECT:/macrocycle/2/workout/1');
  });

  it('renders at the current number, with no redirect, and hands the id to the logger', async () => {
    seedWorkout([{ lift: 'Squat', planned: true, sets: [] }]);
    mockedWorkout.mockResolvedValue({ ...(await mockedWorkout()), macrocycleId: 'mc-a' });

    const element = (await WorkoutLoggingPage({
      params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1' }),
    })) as ReactElement;

    expect(renderToStaticMarkup(element)).toContain('data-macrocycle-id="mc-a"');
  });
});

describe('WorkoutLoggingPage — what an own-max toggle re-plans from (#1153)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("hands the logger each modification's own max, and each planned lift's spec row and max", async () => {
    seedWorkout([{ lift: 'Squat', planned: true, sets: [] }]);
    mockedModificationMaxes.mockResolvedValueOnce([
      { modificationId: 'm-wide', weight: 150, unit: 'lbs', dateUpdated: '2026-11-01T00:00:00.000Z' },
    ]);

    const { lifts, ownMaxes } = await renderPage();

    expect(mockedModificationMaxes).toHaveBeenCalledWith('5-3-1');
    expect(ownMaxes).toEqual({ 'm-wide': 150 });
    // The row names no type, so Squat follows the catalog's linear 5 (#1211).
    expect(lifts[0]?.plan).toEqual({
      spec: spec('Squat'),
      liftMax: 200,
      progression: { rule: { type: 'linear', repsLow: null, repsHigh: 5, increment: 5 } },
    });
  });

  it('gives a lift with no spec row nothing to re-plan from', async () => {
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET] }]);
    mockedSpec.mockResolvedValue([]);

    const { lifts } = await renderPage();

    expect(lifts[0]).not.toHaveProperty('plan');
  });

  it('still renders, planning from the lifts’ maxes, when the own maxes fail to load', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    seedWorkout([{ lift: 'Squat', planned: true, sets: [] }]);
    mockedModificationMaxes.mockRejectedValueOnce(new Error('boom'));

    const { lifts, ownMaxes } = await renderPage();

    expect(ownMaxes).toBeNull();
    expect(lifts[0]?.workingSets.map((s) => s.totalLoad)).toEqual([200]);
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutLoggingPage] own max fetch failed, planning from the lifts’ maxes',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});

// The logger plans by each lift's progression type (#1211). Cable Curl on double, range 8–12:
// 12,12,12 at 30 moved its max to 32.5, so the next plan is 3×8 at 32.5; before that move it
// repeats last session's reps at 30.
describe('WorkoutLoggingPage — the plan follows the lift’s progression type (#1211)', () => {
  const curl = { sets: 3, reps: 12, repsLow: 8, progression: 'double' as const, increment: 2.5, warmUpPct: '' };
  // The workout carries the lift's last session (#1252): workout 4's, on 2026-01-05.
  const curlWith = (reps: number[]) => [
    { lift: 'Cable Curl', planned: true, sets: [], lastSession: { date: '2026-01-05', reps } },
  ];
  const planned = (lift: LiftData | undefined) => lift?.workingSets.map((s) => `${s.reps}@${s.totalLoad}`);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('plans the Cable Curl double at 3×8 after the bump, and last session’s reps before it', async () => {
    seedWorkout(curlWith([12, 12, 12]), { specOverrides: curl });
    mockedMaxes.mockResolvedValueOnce([{ lift: 'Cable Curl', weight: 32.5, dateUpdated: '2026-01-05T00:00:00.000Z' }]);
    const after = await renderPage();
    expect(planned(after.lifts[0])).toEqual(['8@32.5', '8@32.5', '8@32.5']);

    seedWorkout(curlWith([12, 11, 10]), { specOverrides: curl });
    mockedMaxes.mockResolvedValueOnce([{ lift: 'Cable Curl', weight: 30, dateUpdated: '2026-01-01T00:00:00.000Z' }]);
    const before = await renderPage();
    expect(planned(before.lifts[0])).toEqual(['12@30', '11@30', '10@30']);
    // The last session comes with the workout, not from the macrocycle's records (#1252).
    expect(mockedLiftRecords).not.toHaveBeenCalled();
  });

  const hammerCurl = { progression: 'linear', progressionIncrement: 2.5, repsLow: null, repsHigh: 10 };

  it('plans an off-program linear lift at its repsHigh', async () => {
    seedWorkout([{ lift: 'Hammer Curl', planned: true, sets: [] }]);
    mockedSpec.mockResolvedValue([]);
    mockedLiftMetadata.mockResolvedValueOnce([{ lift: 'Hammer Curl', ...hammerCurl }]);

    const { lifts } = await renderPage();

    expect(planned(lifts[0])).toEqual(['10@200', '10@200', '10@200']);
    // Nothing reads its last session: it isn't on double.
    expect(mockedLiftRecords).not.toHaveBeenCalled();
    expect(lifts[0]).not.toHaveProperty('plan');
    // With no spec row, Finish workout still knows how it progresses (#1272).
    expect(lifts[0]?.progressionRule).toEqual({ type: 'linear', increment: 2.5 });
  });

  it("passes each lift's resolved type on, so Finish workout can leave out a manual lift (#1272)", async () => {
    seedWorkout([{ lift: 'Cable Curl', planned: true, sets: [] }], {
      specOverrides: { ...curl, progression: 'manual' as const },
    });

    const { lifts } = await renderPage();

    expect(lifts[0]?.progressionRule).toEqual({ type: 'manual', increment: 2.5 });
  });

  it("finds a lift's settings under another spelling, as updateMaxes does", async () => {
    seedWorkout([{ lift: 'Bench P.', planned: true, sets: [] }]);
    mockedSpec.mockResolvedValue([]);
    mockedLiftMetadata.mockResolvedValueOnce([{ lift: 'Bench Press', ...hammerCurl, repsHigh: 8 }]);

    const { lifts } = await renderPage();

    expect(planned(lifts[0])).toEqual(['8@200', '8@200', '8@200']);
  });

  it('keeps a finished workout read-only when it logged an off-program lift', async () => {
    const set = (setNum: number) => ({ ...LOGGED_SET, id: `hammer-${setNum}`, setNum, reps: 10 });
    seedWorkout([{ lift: 'Hammer Curl', planned: false, sets: [set(1), set(2)] }]);
    mockedSpec.mockResolvedValue([]);
    mockedLiftMetadata.mockResolvedValueOnce([{ lift: 'Hammer Curl', ...hammerCurl }]);

    const { lifts, readOnly } = await renderPage();

    expect(lifts[0]?.workingSets.map((s) => s.setNum)).toEqual([1, 2]);
    expect(readOnly).toBe(true);
  });

  it("still plans the sets left of an off-program lift logged partway through today's workout", async () => {
    seedWorkout([{ lift: 'Hammer Curl', planned: false, sets: [{ ...LOGGED_SET, id: 'hammer-1', reps: 10 }] }]);
    mockedSpec.mockResolvedValue([]);
    mockedLiftMetadata.mockResolvedValueOnce([{ lift: 'Hammer Curl', ...hammerCurl }]);
    // The workout is dated today.
    mockedUserToday.mockResolvedValue('2026-01-06');
    const { lifts, readOnly } = await renderPage().finally(() => mockedUserToday.mockResolvedValue('2026-10-30'));

    expect(lifts[0]?.workingSets.map((s) => [s.setNum, Boolean(s.existing)])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(readOnly).toBe(false);
  });

  it('plans by each row and the catalog, and says why, when the settings read fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    seedWorkout([{ lift: 'Cable Curl', planned: true, sets: [] }], { specOverrides: { ...curl, progression: undefined } });
    mockedUserSettings.mockRejectedValueOnce(new Error('boom'));

    const { lifts } = await renderPage();

    // The row names no type, so Cable Curl follows the catalog's double: the bottom of its range.
    expect(planned(lifts[0])).toEqual(['8@200', '8@200', '8@200']);
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutLoggingPage] progression settings read failed, planning each lift by its row and the catalog',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  // The API leaves `lastSession` off when the lift has none.
  it('plans a double lift as right after a bump when the workout carries no last session', async () => {
    seedWorkout([{ lift: 'Cable Curl', planned: true, sets: [] }], { specOverrides: curl });
    mockedMaxes.mockResolvedValueOnce([{ lift: 'Cable Curl', weight: 30, dateUpdated: '2026-01-01T00:00:00.000Z' }]);

    const { lifts } = await renderPage();

    expect(planned(lifts[0])).toEqual(['8@30', '8@30', '8@30']);
    expect(mockedLiftRecords).not.toHaveBeenCalled();
  });
});
