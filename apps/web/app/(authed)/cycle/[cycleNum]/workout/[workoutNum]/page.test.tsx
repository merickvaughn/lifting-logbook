import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { LiftData } from './types';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
  fetchLatestBodyWeight: jest.fn().mockResolvedValue(null),
  // Not imported by the page any more (issue #978); kept on the mock so the
  // assertion below can prove the whole-cycle refetch is gone rather than
  // merely unmocked.
  fetchLiftRecords: jest.fn(),
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
}));

// The logger is the one child whose props this test cares about. Echo them.
jest.mock('./WorkoutLogger', () => ({
  __esModule: true,
  default: ({ lifts, isReadOnly }: { lifts: LiftData[]; isReadOnly: boolean }) => (
    <div data-lifts={JSON.stringify(lifts)} data-readonly={String(isReadOnly)} />
  ),
}));

import {
  fetchWorkout,
  fetchProgramSpec,
  fetchTrainingMaxes,
  fetchLiftRecords,
} from '@/lib/api';
import WorkoutLoggingPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedSpec = fetchProgramSpec as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedLiftRecords = fetchLiftRecords as unknown as jest.Mock;

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

// `sets` is loosely typed on purpose: the planned-lift case feeds the mock the
// id-less, spec-shaped sets the Playwright mock API sends.
function seedWorkout(lifts: { lift: string; planned: boolean; sets: Record<string, unknown>[] }[]) {
  mockedWorkout.mockResolvedValue({
    program: '5-3-1',
    cycleNum: 1,
    workoutNum: 1,
    week: 1,
    date: '2026-01-06',
    skipped: false,
    lifts,
  });
  mockedSpec.mockResolvedValue(lifts.map((l) => spec(l.lift)));
  mockedMaxes.mockResolvedValue(lifts.map((l) => ({ lift: l.lift, weight: 200 })));
}

async function renderPage(): Promise<{ lifts: LiftData[]; readOnly: boolean }> {
  const element = (await WorkoutLoggingPage({
    params: Promise.resolve({ cycleNum: '1', workoutNum: '1' }),
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
    // The real API sends `planned: true` lifts with no sets; the Playwright mock
    // sends plan-shaped sets without ids. Either way nothing is "existing".
    seedWorkout([{ lift: 'Squat', planned: true, sets: [{ setNum: 1, weight: 200, reps: 5, amrap: false }] }]);

    const { lifts, readOnly } = await renderPage();

    expect(lifts[0]?.workingSets).toHaveLength(1);
    expect(lifts[0]?.workingSets[0]?.existing).toBeUndefined();
    expect(readOnly).toBe(false);
  });

  it('no longer fetches the cycle’s lift records to recover set ids', async () => {
    seedWorkout([{ lift: 'Squat', planned: false, sets: [LOGGED_SET] }]);

    await renderPage();

    expect(mockedLiftRecords).not.toHaveBeenCalled();
    expect(mockedWorkout).toHaveBeenCalledWith('5-3-1', 1);
  });
});
