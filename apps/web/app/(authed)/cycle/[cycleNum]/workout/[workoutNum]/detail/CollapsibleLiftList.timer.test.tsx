import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import WorkoutTimerProvider from '@/components/timer/WorkoutTimerProvider';
import { loadTimerSettings, saveTimerSettings } from '@/lib/timerSettings';
import CollapsibleLiftList from './CollapsibleLiftList';
import type { LiftDetail } from './CollapsibleLiftList';

jest.mock('@/lib/timerAlerts', () => ({
  beep: jest.fn(),
  buzz: jest.fn(),
  requestWakeLock: jest.fn(async () => null),
  releaseWakeLock: jest.fn(async () => undefined),
}));

const LIFT_DETAILS: LiftDetail[] = [
  {
    lift: 'Bench Press',
    tm: 285,
    warmUpCount: 1,
    workCount: 2,
    plannedSets: [
      { type: 'warmup', setLabel: 'Warm-up 1', weight: 135, reps: 5 },
      { type: 'work', setLabel: 'Set 1', weight: 200, reps: 5 },
      { type: 'work', setLabel: 'Set 2', weight: 230, reps: 3 },
    ],
  },
];

const TIMER_LIFTS: TimerLiftPlan[] = [
  {
    lift: 'Bench Press',
    tm: 'TM: 285 lbs',
    sets: [
      { type: 'warmup', setLabel: 'Warm-up 1', spec: '5 × 135 lbs' },
      { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
      { type: 'work', setLabel: 'Set 2', spec: '3 × 230 lbs' },
    ],
  },
];

function renderList({ withTimer }: { withTimer: boolean }) {
  const list = (
    <CollapsibleLiftList
      liftDetails={LIFT_DETAILS}
      cycleNum={1}
      workoutNum={1}
      unit="lbs"
    />
  );

  return render(
    withTimer ?
      <WorkoutTimerProvider lifts={TIMER_LIFTS} program="531" cycleNum={1} workoutNum={1}>
        {list}
      </WorkoutTimerProvider>
    : list,
  );
}

/**
 * The lift's collapse toggle.
 *
 * Matched on its set-count summary rather than the lift name: once the timer is
 * mounted, every play control's accessible name also contains the lift name.
 */
function liftHeader() {
  return screen.getByRole('button', { name: /1 warm-up/ });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('CollapsibleLiftList with the timer', () => {
  it('renders no play controls outside a timer provider', async () => {
    const user = userEvent.setup();
    renderList({ withTimer: false });

    await user.click(liftHeader());

    expect(screen.queryByRole('button', { name: /^Start timer at/ })).not.toBeInTheDocument();
    expect(screen.getByText('Set 1')).toBeInTheDocument();
  });

  it('gives every timed set a descriptively-named play control', async () => {
    const user = userEvent.setup();
    renderList({ withTimer: true });

    await user.click(liftHeader());

    // "▶" alone is not an accessible name — each control names its own set.
    expect(
      screen.getByRole('button', { name: 'Start timer at Bench Press Warm-up 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start timer at Bench Press Set 2' }),
    ).toBeInTheDocument();
  });

  it('starts the session at the chosen set', async () => {
    const user = userEvent.setup();
    renderList({ withTimer: true });

    await user.click(liftHeader());
    await user.click(screen.getByRole('button', { name: 'Start timer at Bench Press Set 2' }));

    // The dock opens on that set's prep phase and names the set it is preparing for.
    expect(screen.getByRole('button', { name: 'Expand timer' })).toBeInTheDocument();
    expect(screen.getByText(/Bench Press — Set 2 · 3 × 230 lbs/)).toBeInTheDocument();
  });

  it('auto-expands the lift the timer moves to', async () => {
    const user = userEvent.setup();
    renderList({ withTimer: true });

    // Every set row is always in the DOM — collapsing is presentational — so the
    // header's aria-expanded is what actually reports the panel state.
    expect(liftHeader()).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: 'Start timer at Bench Press Set 1' }));

    expect(liftHeader()).toHaveAttribute('aria-expanded', 'true');
  });

  it('omits the play control for sets the timer does not queue', async () => {
    // Warm-ups run untimed under this setting, so their rows must not offer a
    // control that would silently start somewhere else.
    const settings = loadTimerSettings();
    settings.behavior.skipWarmups = true;
    saveTimerSettings(settings);

    const user = userEvent.setup();
    renderList({ withTimer: true });

    await user.click(liftHeader());

    expect(
      screen.queryByRole('button', { name: 'Start timer at Bench Press Warm-up 1' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start timer at Bench Press Set 1' }),
    ).toBeInTheDocument();
  });

  it('marks the running set active and finished sets done', async () => {
    const user = userEvent.setup();
    renderList({ withTimer: true });

    await user.click(liftHeader());
    await user.click(screen.getByRole('button', { name: 'Start timer at Bench Press Set 1' }));

    // identity-obj-proxy maps a CSS-module class to its own name.
    const rowFor = (label: string) =>
      screen.getByText(label).closest('div[class*="setRow"]');

    expect(rowFor('Set 1')?.className).toContain('setRowActive');
    expect(rowFor('Warm-up 1')?.className).toContain('setRowDone');
    expect(rowFor('Set 2')?.className).not.toContain('setRowDone');
  });
});
