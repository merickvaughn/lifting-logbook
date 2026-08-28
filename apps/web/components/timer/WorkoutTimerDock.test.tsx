import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import WorkoutTimerProvider, { useTimerRowState } from './WorkoutTimerProvider';

jest.mock('@/lib/timerAlerts', () => ({
  beep: jest.fn(),
  buzz: jest.fn(),
  requestWakeLock: jest.fn(async () => null),
  releaseWakeLock: jest.fn(async () => undefined),
}));

const LIFTS: TimerLiftPlan[] = [
  {
    lift: 'Bench Press',
    tm: 'TM: 285 lbs',
    sets: [
      { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
      { type: 'work', setLabel: 'Set 2', spec: '3 × 230 lbs' },
    ],
  },
];

function Harness({ lifts = LIFTS }: { lifts?: TimerLiftPlan[] }) {
  return (
    <WorkoutTimerProvider lifts={lifts} program="531" cycleNum={1} workoutNum={1}>
      <StartButton />
    </WorkoutTimerProvider>
  );
}

// A minimal stand-in for the detail page's start action, so these tests exercise
// the dock through the same context the real page uses.
function StartButton() {
  const timer = useTimerRowState();
  return (
    <button type="button" onClick={() => timer?.startSession()}>
      Start timed workout
    </button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('WorkoutTimerDock', () => {
  it('renders nothing until a session starts', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: 'Expand timer' })).not.toBeInTheDocument();
  });

  it('appears once a session starts, showing the phase and lift', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Start timed workout' }));

    expect(screen.getByRole('button', { name: 'Expand timer' })).toBeInTheDocument();
    expect(screen.getByText(/Bench Press/)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });

  it('toggles pause and back', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Start timed workout' }));

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('advances through phases when skipped', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Start timed workout' }));

    // Opens on the prep phase ("Get set"); skipping lands on the working set.
    expect(screen.getByText(/Get set/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByText(/Working set/i)).toBeInTheDocument();
  });

  describe('the expanded sheet', () => {
    it('opens as a modal dialog and closes again', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Start timed workout' }));

      await user.click(screen.getByRole('button', { name: 'Expand timer' }));

      const dialog = screen.getByRole('dialog', { name: 'Workout timer' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');

      await user.click(within(dialog).getByRole('button', { name: /Back to workout/ }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes on Escape', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Start timed workout' }));
      await user.click(screen.getByRole('button', { name: 'Expand timer' }));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('moves focus into the dialog on open and restores it on close', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Start timed workout' }));

      const expand = screen.getByRole('button', { name: 'Expand timer' });
      await user.click(expand);

      const dialog = screen.getByRole('dialog');
      expect(dialog.contains(document.activeElement)).toBe(true);

      await user.keyboard('{Escape}');
      expect(document.activeElement).toBe(expand);
    });

    it('offers the full timer page', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Start timed workout' }));
      await user.click(screen.getByRole('button', { name: 'Expand timer' }));

      expect(screen.getByRole('link', { name: /Full timer/ })).toHaveAttribute(
        'href',
        '/cycle/1/workout/1/timer',
      );
    });

    it('closes itself when the session ends', async () => {
      const user = userEvent.setup();
      render(<Harness />);
      await user.click(screen.getByRole('button', { name: 'Start timed workout' }));
      await user.click(screen.getByRole('button', { name: 'Expand timer' }));

      await user.click(screen.getByRole('button', { name: 'End timer' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Expand timer' })).not.toBeInTheDocument();
    });
  });
});
