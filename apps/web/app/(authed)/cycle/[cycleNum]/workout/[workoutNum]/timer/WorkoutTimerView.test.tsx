import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TimerLiftPlan } from '@lifting-logbook/core';
import WorkoutTimerView from './WorkoutTimerView';

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
      { type: 'warmup', setLabel: 'Warm-up 1', spec: '5 × 135 lbs' },
      { type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' },
    ],
  },
];

function renderView(lifts: TimerLiftPlan[] = LIFTS) {
  return render(
    <WorkoutTimerView lifts={lifts} program="531" cycleNum={1} workoutNum={2} week={3} />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('WorkoutTimerView', () => {
  it('opens on the Timer tab, ready but not running', () => {
    renderView();

    expect(screen.getByRole('tab', { name: 'Timer' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
  });

  it('summarises the timed plan before starting', () => {
    renderView();
    // 2 sets: prep 10 + warm-up 30 + rest 90 + prep 10 + work 60 = 200s.
    expect(screen.getByText(/2 timed sets · 3:20 estimated/)).toBeInTheDocument();
  });

  it('links back to the workout detail page', () => {
    renderView();
    expect(screen.getByRole('link', { name: /Week 3 · Workout 2/ })).toHaveAttribute(
      'href',
      '/cycle/1/workout/2/detail',
    );
  });

  it('starts, pauses and resumes', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(screen.getByText(/Set 1 of 2/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText(/^Paused ·/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.queryByText(/^Paused ·/)).not.toBeInTheDocument();
  });

  it('ends the session with End timer', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await user.click(screen.getByRole('button', { name: 'End timer' }));

    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('disables the run controls while idle', () => {
    renderView();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+30s' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('lists the session queue with a row per phase', () => {
    renderView();
    const queue = screen.getByRole('list');
    // 2 sets x 3 phases, minus the trailing rest.
    expect(within(queue).getAllByRole('listitem')).toHaveLength(5);
  });

  it('exposes the countdown as a timer, not a chatty live region', () => {
    renderView();
    // role="timer" carries an implicit aria-live="off", so the 200ms updates are
    // not announced; phase transitions get their own polite region instead.
    expect(screen.getByRole('timer')).toBeInTheDocument();
  });

  it('handles a workout with nothing to time', () => {
    renderView([]);
    expect(screen.getByText(/No timed sets/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
  });

  describe('the Settings tab', () => {
    it('switches panels', async () => {
      const user = userEvent.setup();
      renderView();

      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      expect(screen.getByRole('heading', { name: 'Timer settings' })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Standard' })).toBeChecked();
    });

    it('changes the preset and reflects it in the plan estimate', async () => {
      const user = userEvent.setup();
      renderView();

      await user.click(screen.getByRole('tab', { name: 'Settings' }));
      await user.click(screen.getByRole('radio', { name: 'Heavy day' }));
      await user.click(screen.getByRole('tab', { name: 'Timer' }));

      // Heavy day lengthens prep (15) and working rest, so the estimate grows.
      expect(screen.queryByText(/3:20 estimated/)).not.toBeInTheDocument();
    });

    it('edits a duration through the stepper', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      const before = screen.getByLabelText('Working set') as HTMLInputElement;
      expect(before.value).toBe('1:00');

      await user.click(screen.getByRole('button', { name: 'Increase Working set' }));
      expect((screen.getByLabelText('Working set') as HTMLInputElement).value).toBe('1:05');
    });

    it('gives same-labelled durations distinct accessible names', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      // "Working set" appears under the preset AND under the deload defaults. Both
      // must be individually addressable, or a screen-reader user cannot tell which
      // one they are editing.
      expect(screen.getByLabelText('Working set')).toBeInTheDocument();
      expect(screen.getByLabelText('Working set (Deload)')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Bench Press/ }));
      expect(screen.getByLabelText('Working set (Bench Press)')).toBeInTheDocument();
    });

    it('keeps the previous value when a typed duration is unparseable', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      const input = screen.getByLabelText('Working set');
      await user.clear(input);
      await user.type(input, 'abc');
      await user.tab();

      expect((screen.getByLabelText('Working set') as HTMLInputElement).value).toBe('1:00');
    });

    it('toggles a behavior switch', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      const skip = screen.getByRole('switch', { name: 'Skip warm-up timers' });
      expect(skip).toHaveAttribute('aria-checked', 'false');

      await user.click(skip);
      expect(screen.getByRole('switch', { name: 'Skip warm-up timers' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    it('renders the accessory card with its own accessible names', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      // "Working set" now appears under the preset, the deload defaults AND the
      // accessory defaults. All three must stay individually addressable.
      expect(screen.getByLabelText('Working set')).toBeInTheDocument();
      expect(screen.getByLabelText('Working set (Deload)')).toBeInTheDocument();
      expect(screen.getByLabelText('Working set (Accessory)')).toBeInTheDocument();
      expect(screen.getByLabelText('Between working sets (Accessory)')).toBeInTheDocument();
    });

    it('ships the accessory rule switched on', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      expect(
        screen.getByRole('switch', { name: 'Shorter rest for accessories' }),
      ).toHaveAttribute('aria-checked', 'true');
      expect(
        (screen.getByLabelText('Between working sets (Accessory)') as HTMLInputElement).value,
      ).toBe('1:30');
    });

    it('toggles the accessory rule off', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      await user.click(screen.getByRole('switch', { name: 'Shorter rest for accessories' }));

      expect(
        screen.getByRole('switch', { name: 'Shorter rest for accessories' }),
      ).toHaveAttribute('aria-checked', 'false');
    });

    it('keeps the accessory settings when an unrelated setting is edited', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      const accessoryRest = screen.getByLabelText('Between working sets (Accessory)');
      await user.clear(accessoryRest);
      await user.type(accessoryRest, '1:15');
      await user.tab();

      // The panel clones settings field-by-field before every change. An
      // omitted context field there is invisible until some *other* edit
      // silently discards it — so edit something unrelated and check.
      await user.click(screen.getByRole('switch', { name: 'Keep screen awake' }));

      expect(
        (screen.getByLabelText('Between working sets (Accessory)') as HTMLInputElement).value,
      ).toBe('1:15');
      expect(
        screen.getByRole('switch', { name: 'Shorter rest for accessories' }),
      ).toHaveAttribute('aria-checked', 'true');
    });

    it('shortens an accessory lift in the plan estimate but not a compound one', async () => {
      const user = userEvent.setup();
      // Two sets on the accessory, deliberately: buildTimerQueue drops the
      // trailing rest, so with one set each the accessory's shortened *rest*
      // would never reach the estimate and only its 45s set would differ.
      //   bench   prep 10 + set 60 + rest 240        = 310
      //   curls 1 prep 10 + set 45 + rest  90        = 145
      //   curls 2 prep 10 + set 45 (rest dropped)    =  55  -> 8:30
      renderView([
        {
          lift: 'Bench Press',
          classification: 'compound',
          sets: [{ type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' }],
        },
        {
          lift: 'Cable Curls',
          classification: 'accessory',
          sets: [
            { type: 'work', setLabel: 'Set 1', spec: '10 × 40 lbs' },
            { type: 'work', setLabel: 'Set 2', spec: '10 × 40 lbs' },
          ],
        },
      ]);

      expect(screen.getByText(/3 timed sets · 8:30 estimated/)).toBeInTheDocument();

      // Rule off: every lift runs on the preset — 310 + 310 + 70 = 11:30.
      await user.click(screen.getByRole('tab', { name: 'Settings' }));
      await user.click(screen.getByRole('switch', { name: 'Shorter rest for accessories' }));
      await user.click(screen.getByRole('tab', { name: 'Timer' }));

      expect(screen.getByText(/3 timed sets · 11:30 estimated/)).toBeInTheDocument();
    });

    it('says what a lift follows, rather than always naming the preset', async () => {
      const user = userEvent.setup();
      renderView([
        {
          lift: 'Cable Curls',
          classification: 'accessory',
          sets: [{ type: 'work', setLabel: 'Set 1', spec: '10 × 40 lbs' }],
        },
      ]);
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      expect(screen.getByText('Follows Accessory')).toBeInTheDocument();

      await user.click(screen.getByRole('switch', { name: 'Shorter rest for accessories' }));
      expect(screen.getByText('Follows Standard')).toBeInTheDocument();
    });

    it('records a per-lift override and can clear it', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Settings' }));

      await user.click(screen.getByRole('button', { name: /Bench Press/ }));
      expect(screen.getByText('Follows Standard')).toBeInTheDocument();

      const overrideInput = screen.getByLabelText('Working set (Bench Press)');
      await user.clear(overrideInput);
      await user.type(overrideInput, '1:30');
      await user.tab();

      expect(screen.getByText('1 override')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Clear overrides for Bench Press/ }));
      expect(screen.getByText('Follows Standard')).toBeInTheDocument();
    });
  });
});
