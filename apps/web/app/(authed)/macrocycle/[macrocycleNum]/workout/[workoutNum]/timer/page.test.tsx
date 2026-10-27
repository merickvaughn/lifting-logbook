import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { TimerLiftPlan } from '@lifting-logbook/core';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
  fetchCustomLifts: jest.fn(),
  // No active focus block unless a test says otherwise.
  fetchFocusPlan: jest.fn().mockResolvedValue({ groups: [] }),
}));

jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  redirect: jest.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// Echo the resolved plan so the test can assert what the page passed down,
// rather than inferring it from the live timer's rendered durations.
jest.mock('./WorkoutTimerView', () => ({
  __esModule: true,
  default: ({ lifts }: { lifts: TimerLiftPlan[] }) => (
    <div data-lifts={JSON.stringify(lifts.map((l) => [l.lift, l.classification]))} />
  ),
}));

import { fetchWorkout, fetchProgramSpec, fetchTrainingMaxes, fetchCustomLifts, fetchFocusPlan } from '@/lib/api';
import { focusPlan } from '@/lib/__tests__/focusPlanFixture';
import WorkoutTimerPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedSpec = fetchProgramSpec as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedCustomLifts = fetchCustomLifts as unknown as jest.Mock;
const mockedFocusPlan = fetchFocusPlan as unknown as jest.Mock;

function spec(lift: string) {
  return {
    week: 1,
    lift,
    order: 1,
    offset: 0,
    increment: 5,
    sets: 3,
    reps: 5,
    amrap: false,
    warmUpPct: '40,50,60',
    wtDecrementPct: 0,
    activation: '',
  };
}

/** "Squat" is a compound built-in; "Cable Curls" is an accessory built-in. */
function seedWorkout(lifts: string[]) {
  mockedWorkout.mockResolvedValue({
    program: '5-3-1',
    macrocycleNum: 1,
    workoutNum: 1,
    week: 1,
    date: '2999-01-01',
    skipped: false,
    lifts: lifts.map((lift) => ({ lift, sets: [], planned: true })),
  });
  mockedSpec.mockResolvedValue(lifts.map(spec));
  mockedMaxes.mockResolvedValue(lifts.map((lift) => ({ lift, weight: 200 })));
}

/** The `[lift, classification]` pairs the page handed to the timer view. */
function passedLifts(html: string): [string, string | null][] {
  const encoded = html.match(/data-lifts="([^"]*)"/)?.[1];
  if (encoded === undefined) throw new Error('data-lifts attribute not found in rendered output');
  return JSON.parse(encoded.replace(/&quot;/g, '"'));
}

async function renderPage(): Promise<string> {
  const element = (await WorkoutTimerPage({
    params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1' }),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('WorkoutTimerPage — accessory classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedWorkout(['Squat', 'Cable Curls']);
  });

  it('classifies each lift and passes it to the timer', async () => {
    mockedCustomLifts.mockResolvedValue([]);

    expect(passedLifts(await renderPage())).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
    ]);
  });

  // The classification matrix (custom lifts, slow fetch, deferred await) lives
  // in apps/web/lib/__tests__/loadWorkoutPlan.test.ts now; this page test keeps
  // one success and one failure case to prove the page → loader → view wiring.
  it('still renders, and still classifies built-ins, when the custom-lift fetch fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedCustomLifts.mockRejectedValue(new Error('API down'));

    // The paired assertion the fallback needs: not merely that the page renders,
    // but that built-in classification is still correct through it. A structural
    // "it rendered" check would pass just as well against a page that had
    // silently stopped classifying anything at all.
    expect(passedLifts(await renderPage())).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
    ]);

    // Degraded, not silent.
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutTimerPage] custom lifts fetch failed, classifying built-ins only',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('redirects to the detail page for a workout that is no longer timeable', async () => {
    mockedCustomLifts.mockResolvedValue([]);
    mockedWorkout.mockResolvedValue({
      program: '5-3-1',
      macrocycleNum: 1,
      workoutNum: 1,
      week: 1,
      date: '2999-01-01',
      skipped: true,
      lifts: [{ lift: 'Squat', sets: [], planned: true }],
    });

    await expect(renderPage()).rejects.toThrow('REDIRECT:/macrocycle/1/workout/1/detail');
  });
});

describe('WorkoutTimerPage — focus work (#1060)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedWorkout(['Squat', 'Cable Curls']);
    mockedCustomLifts.mockResolvedValue([]);
  });

  it('queues the day’s focus lifts after the planned lifts', async () => {
    mockedFocusPlan.mockResolvedValueOnce(focusPlan());

    expect(passedLifts(await renderPage())).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
      ['Lateral Raise', 'accessory'],
      ['Face Pull', 'accessory'],
    ]);
    expect(mockedFocusPlan).toHaveBeenCalledWith('5-3-1', 1, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('times the planned lifts alone when the focus plan fails to load', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedFocusPlan.mockRejectedValueOnce(new Error('API down'));

    expect(passedLifts(await renderPage())).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
    ]);
    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutTimerPage] focus plan fetch failed, showing planned lifts only',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
