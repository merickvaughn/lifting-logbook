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
}));

// The provider is what carries the timed plan to the docked mini-timer, so it is
// the one child whose props this test cares about. Echo them; render children so
// the rest of the page still exercises its own code path.
jest.mock('@/components/timer/WorkoutTimerProvider', () => ({
  __esModule: true,
  default: ({ lifts, children }: { lifts: TimerLiftPlan[]; children: React.ReactNode }) => (
    <div data-lifts={JSON.stringify(lifts.map((l) => [l.lift, l.classification]))}>{children}</div>
  ),
}));

// Stubbed only to keep this test about the page's own fetch-and-classify path;
// each has (or warrants) its own coverage.
jest.mock('./CollapsibleLiftList', () => ({
  __esModule: true,
  default: () => <div>collapsible-lift-list</div>,
}));
jest.mock('./StartTimedWorkout', () => ({
  __esModule: true,
  default: () => <div>start-timed-workout</div>,
}));
jest.mock('./RescheduleForm', () => ({
  __esModule: true,
  default: () => <div>reschedule-form</div>,
}));
jest.mock('./SkipForm', () => ({ __esModule: true, default: () => <div>skip-form</div> }));

import { fetchWorkout, fetchProgramSpec, fetchTrainingMaxes, fetchCustomLifts } from '@/lib/api';
import WorkoutDetailPage from './page';

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

/** A future-dated, unlogged workout — the state in which the timer is offered. */
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

function passedLifts(html: string): [string, string | null][] {
  const encoded = html.match(/data-lifts="([^"]*)"/)?.[1];
  if (encoded === undefined) throw new Error('data-lifts attribute not found in rendered output');
  return JSON.parse(encoded.replace(/&quot;/g, '"'));
}

async function renderPage(): Promise<string> {
  const element = (await WorkoutDetailPage({
    params: Promise.resolve({ cycleNum: '1', workoutNum: '1' }),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('WorkoutDetailPage — accessory classification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedWorkout(['Squat', 'Cable Curls']);
  });

  it('classifies each lift and hands it to the timer provider', async () => {
    mockedCustomLifts.mockResolvedValue([]);

    // The dock must resolve the same durations as the timer page, so this page
    // has to classify too — not just the /timer route.
    expect(passedLifts(await renderPage())).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
    ]);
  });

  it('hands the timer every lift in plan order, including one the spec does not plan', async () => {
    // Position is a lift's identity for the timer (issue #980): the plan the
    // provider receives must line up index-for-index with the list this page
    // renders, so a lift with nothing planned is passed through (empty), not
    // filtered out. A `liftDetails.filter(...)` here would compile and silently
    // point every ▶ and every persisted run at the wrong lift.
    mockedCustomLifts.mockResolvedValue([]);
    mockedSpec.mockResolvedValue([spec('Cable Curls')]);

    expect(passedLifts(await renderPage()).map(([lift]) => lift)).toEqual(['Squat', 'Cable Curls']);
  });

  it('mounts no timer, and never awaits the custom-lift fetch, for a logged workout', async () => {
    // The other side of `timerAvailable`, and the property the deferred await
    // exists for: a completed workout is most detail-page traffic, and it must
    // not pay for the optional enrichment. `fetchCustomLifts` never settles here,
    // so collapsing the page to an unconditional `await plan.timerLifts()` hangs
    // this test instead of quietly putting the round-trip back on the hot path.
    mockedCustomLifts.mockReturnValue(new Promise(() => undefined));
    mockedWorkout.mockResolvedValue({
      program: '5-3-1',
      cycleNum: 1,
      workoutNum: 1,
      week: 1,
      date: '2020-01-01',
      skipped: false,
      lifts: [{ lift: 'Squat', sets: [{ setNum: 1, weight: 225, reps: 5, notes: '' }], planned: false }],
    });

    const html = await renderPage();

    expect(html).toContain('Planned Lifts');
    expect(html).toContain('✓ Done');
    // The provider is the timer's mount point; its absence is the assertion.
    expect(html).not.toContain('data-lifts');
  });

  // The classification matrix (custom lifts, slow fetch, deferred await) lives
  // in apps/web/lib/__tests__/loadWorkoutPlan.test.ts now; this page test keeps
  // one success, the plan/list alignment pin, and one failure case to prove the
  // page → loader → provider wiring.
  it('still renders, and still classifies built-ins, when the custom-lift fetch fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedCustomLifts.mockRejectedValue(new Error('API down'));

    const html = await renderPage();

    // Paired with the success path above: asserting only that the page rendered
    // would pass equally against one that had stopped classifying entirely.
    expect(passedLifts(html)).toEqual([
      ['Squat', 'compound'],
      ['Cable Curls', 'accessory'],
    ]);
    expect(html).toContain('Planned Lifts');

    expect(errSpy).toHaveBeenCalledWith(
      '[WorkoutDetailPage] custom lifts fetch failed, classifying built-ins only',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
