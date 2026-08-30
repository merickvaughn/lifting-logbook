import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { TimerLiftPlan } from '@lifting-logbook/core';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
  fetchCustomLifts: jest.fn(),
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

import { fetchWorkout, fetchProgramSpec, fetchTrainingMaxes, fetchCustomLifts } from '@/lib/api';
import WorkoutTimerPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedSpec = fetchProgramSpec as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedCustomLifts = fetchCustomLifts as unknown as jest.Mock;

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
    cycleNum: 1,
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
    params: Promise.resolve({ cycleNum: '1', workoutNum: '1' }),
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

  it('classifies a custom lift from the fetched list', async () => {
    seedWorkout(['Sissy Squat']);
    mockedCustomLifts.mockResolvedValue([
      { name: 'Sissy Squat', classification: 'accessory' },
    ]);

    expect(passedLifts(await renderPage())).toEqual([['Sissy Squat', 'accessory']]);
  });

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
      'WorkoutTimerPage: custom lifts fetch failed, classifying built-ins only',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it('loses only the custom lift when the fetch fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    seedWorkout(['Squat', 'Sissy Squat']);
    mockedCustomLifts.mockRejectedValue(new Error('API down'));

    // The honest cost of the fallback: a custom lift goes unclassified and falls
    // through to the preset. It is still in the session — never dropped.
    expect(passedLifts(await renderPage())).toEqual([
      ['Squat', 'compound'],
      ['Sissy Squat', null],
    ]);
    errSpy.mockRestore();
  });
});
