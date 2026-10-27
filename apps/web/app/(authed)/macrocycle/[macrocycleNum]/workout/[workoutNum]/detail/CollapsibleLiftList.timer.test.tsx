import { render, screen, within } from '@testing-library/react';
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
    // Spelled out because `activationMovement` is required-but-nullable: a
    // fixture cannot inherit "no activation" by omission, which is what let the
    // pre-#984 raw-column shape satisfy the interface silently.
    activationMovement: undefined,
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

function renderList({
  withTimer,
  liftDetails = LIFT_DETAILS,
}: {
  withTimer: boolean;
  liftDetails?: LiftDetail[];
}) {
  const list = (
    <CollapsibleLiftList
      liftDetails={liftDetails}
      macrocycleNum={1}
      workoutNum={1}
      unit="lbs"
    />
  );

  return render(
    withTimer ?
      <WorkoutTimerProvider lifts={TIMER_LIFTS} program="531" macrocycleNum={1} workoutNum={1}>
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

  it('starts and marks the second occurrence of a repeated lift, not the first (#971)', async () => {
    // The program editor keys an instance by position, so one workout can hold
    // the same lift twice with identical set labels. Only position tells the
    // two apart — a name-keyed lookup sent the second occurrence's ▶ to the first.
    const user = userEvent.setup();
    const detail: LiftDetail = {
      lift: 'Bench Press',
      tm: 285,
      activationMovement: undefined,
      warmUpCount: 0,
      workCount: 1,
      plannedSets: [{ type: 'work', setLabel: 'Set 1', weight: 200, reps: 5 }],
    };
    const timerLift: TimerLiftPlan = {
      lift: 'Bench Press',
      tm: 'TM: 285 lbs',
      sets: [{ type: 'work', setLabel: 'Set 1', spec: '5 × 200 lbs' }],
    };
    render(
      <WorkoutTimerProvider lifts={[timerLift, timerLift]} program="531" macrocycleNum={1} workoutNum={1}>
        <CollapsibleLiftList liftDetails={[detail, detail]} macrocycleNum={1} workoutNum={1} unit="lbs" />
      </WorkoutTimerProvider>,
    );
    const [first, second] = screen.getAllByRole('listitem');
    if (!first || !second) throw new Error('expected two lift items');

    await user.click(within(second).getByRole('button', { name: 'Start timer at Bench Press Set 1' }));

    // The dock is on the second occurrence's prep, and only the second item's row is active.
    expect(within(second).getByText('Set 1').closest('div')).toHaveClass('setRowActive');
    expect(within(first).getByText('Set 1').closest('div')).not.toHaveClass('setRowActive');
    expect(within(second).getByRole('button', { name: /1 working/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(first).getByRole('button', { name: /1 working/ })).toHaveAttribute('aria-expanded', 'false');
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

  describe('focus lifts in the timer’s plan (#1060)', () => {
    /** The timer's plan with focus work first: Lateral Raise at 0, Bench Press at 1. */
    const FOCUS_FIRST: TimerLiftPlan[] = [
      {
        lift: 'Lateral Raise',
        durations: { prep: 10, workSet: 45, restWork: 60 },
        sets: [1, 2].map((k) => ({ type: 'work' as const, setLabel: `Set ${k}`, spec: '10–12 reps @ 25 lbs' })),
      },
      ...TIMER_LIFTS,
    ];

    function focusRow(timerIndex?: number) {
      return {
        kind: 'focus' as const,
        id: 'f:b1:Lateral Raise',
        ...(timerIndex !== undefined && { timerIndex }),
        lift: 'Lateral Raise',
        summary: '2 × 10–12',
        groupLabel: 'Focus sets · Double progression',
        sets: 2,
        perSet: '10–12 reps @ 25 lbs',
        hint: 'Hit 12 on every set.',
        note: null,
        area: 'Shoulders',
      };
    }

    function renderFocusFirst(rows: Parameters<typeof CollapsibleLiftList>[0]['rows']) {
      return render(
        <WorkoutTimerProvider lifts={FOCUS_FIRST} program="531" macrocycleNum={1} workoutNum={1}>
          <CollapsibleLiftList liftDetails={LIFT_DETAILS} macrocycleNum={1} workoutNum={1} unit="lbs" rows={rows} />
        </WorkoutTimerProvider>,
      );
    }

    it('starts the timer at a focus lift’s set, and at a planned set by the lift’s place in the queue', async () => {
      const user = userEvent.setup();
      renderFocusFirst([focusRow(0), { kind: 'planned', id: 'p:Bench Press#0', liftIndex: 0, timerIndex: 1 }]);
      const [focusItem, plannedItem] = screen.getAllByRole('listitem');
      if (!focusItem || !plannedItem) throw new Error('expected two lift items');

      await user.click(within(focusItem).getByRole('button', { name: 'Start timer at Lateral Raise Set 2' }));
      expect(screen.getByText(/Lateral Raise — Set 2 · 10–12 reps @ 25 lbs/)).toBeInTheDocument();

      // Bench Press is `liftDetails[0]` but the timer's lift 1: its ▶ must start Bench
      // Press, not the focus lift that sits at index 0 of the queue.
      await user.click(within(plannedItem).getByRole('button', { name: /1 warm-up/ }));
      await user.click(within(plannedItem).getByRole('button', { name: 'Start timer at Bench Press Set 2' }));
      expect(screen.getByText(/Bench Press — Set 2 · 3 × 230 lbs/)).toBeInTheDocument();
    });

    it('marks the focus lift’s active set and links to its history', async () => {
      const user = userEvent.setup();
      renderFocusFirst([focusRow(0)]);

      await user.click(screen.getByRole('button', { name: 'Start timer at Lateral Raise Set 1' }));

      expect(screen.getByText('Set 1').closest('div[class*="setRow"]')?.className).toContain('setRowActive');
      expect(screen.getByRole('link', { name: /History/ })).toHaveAttribute(
        'href',
        '/macrocycle/1/workout/1/detail/Lateral%20Raise',
      );
    });

    it('offers no ▶ on a focus row the timer does not queue', async () => {
      const user = userEvent.setup();
      renderFocusFirst([focusRow()]);

      await user.click(screen.getByRole('button', { name: /Lateral Raise/ }));
      expect(screen.queryByRole('button', { name: /^Start timer at/ })).not.toBeInTheDocument();
    });
  });

  describe('the activation movement (#960)', () => {
    /**
     * `LIFT_DETAILS` with the movement set, as `loadWorkoutPlan` passes it — the
     * raw spec column is narrowed there, so a legacy `'compound'` marker never
     * reaches this list (covered in `lib/__tests__/loadWorkoutPlan.test.ts`).
     */
    function withActivation(activationMovement: string): LiftDetail[] {
      return LIFT_DETAILS.map((detail) => ({ ...detail, activationMovement }));
    }

    it('shows the movement the program names for the lift', async () => {
      const user = userEvent.setup();
      renderList({ withTimer: false, liftDetails: withActivation('Hip Airplane') });

      await user.click(liftHeader());

      expect(screen.getByText('Activation')).toBeInTheDocument();
      expect(screen.getByText('Hip Airplane')).toBeInTheDocument();
    });

    it('gives it no play control — an activation is not a set', async () => {
      const user = userEvent.setup();
      renderList({ withTimer: true, liftDetails: withActivation('Hip Airplane') });

      await user.click(liftHeader());

      expect(
        screen.queryByRole('button', { name: /Start timer at Bench Press Hip Airplane/ }),
      ).not.toBeInTheDocument();
      // The real sets still have theirs.
      expect(
        screen.getByRole('button', { name: 'Start timer at Bench Press Set 1' }),
      ).toBeInTheDocument();
    });

    it('shows nothing when the lift has no activation', async () => {
      const user = userEvent.setup();
      renderList({ withTimer: false });

      await user.click(liftHeader());

      expect(screen.queryByText('Activation')).not.toBeInTheDocument();
    });
  });
});
