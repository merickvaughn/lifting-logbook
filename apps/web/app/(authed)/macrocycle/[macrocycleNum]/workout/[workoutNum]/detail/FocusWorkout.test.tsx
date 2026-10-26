import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyFocusDayState, type FocusDayPlanResponse, type FocusDayState } from '@lifting-logbook/types';
import { focusBlock, focusPlan, planGroup, planItem, poolEntry } from '@/lib/__tests__/focusPlanFixture';
import FocusWorkout from './FocusWorkout';
import type { LiftDetail } from './CollapsibleLiftList';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

jest.mock('@/lib/client-api', () => ({ saveFocusDayState: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

import { saveFocusDayState } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

const mockedSave = saveFocusDayState as unknown as jest.Mock;
const mockedLog = logClientError as unknown as jest.Mock;

const LIFT_DETAILS: LiftDetail[] = [
  {
    lift: 'Squat',
    tm: 315,
    activationMovement: undefined,
    warmUpCount: 1,
    workCount: 1,
    plannedSets: [
      { type: 'warmup', setLabel: 'Warm-up 1', weight: 135, reps: 5 },
      { type: 'work', setLabel: 'Set 1', weight: 285, reps: 5 },
    ],
  },
  {
    lift: 'Bench Press',
    tm: 285,
    activationMovement: undefined,
    warmUpCount: 0,
    workCount: 1,
    plannedSets: [{ type: 'work', setLabel: 'Set 1', weight: 255, reps: 5 }],
  },
];

function dayState(overrides: Partial<FocusDayState> = {}): FocusDayState {
  return { ...emptyFocusDayState(), ...overrides };
}

function renderFocus(plan: FocusDayPlanResponse = focusPlan()) {
  return render(
    <FocusWorkout
      program="5-3-1"
      macrocycleNum={1}
      workoutNum={1}
      week={2}
      unit="lbs"
      liftDetails={LIFT_DETAILS}
      plan={plan}
    />,
  );
}

/** The module headings, in the order they are on the page. */
function moduleOrder(): string[] {
  return screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
}

function summarySection(): HTMLElement {
  const section = screen.getByRole('heading', { name: 'Workout Summary' }).parentElement;
  if (!section) throw new Error('summary section not found');
  return section;
}

/** Lift names in one module's list, in order. */
function liftsIn(heading: string): string[] {
  const section = screen.getByRole('region', { name: heading });
  // identity-obj-proxy maps each CSS-module class to its own name.
  return Array.from(section.querySelectorAll('[data-row-id] .liftName')).map((name) => name.textContent ?? '');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSave.mockImplementation(async (_p: string, _w: number, body: FocusDayState) => body);
});

describe('FocusWorkout — summary', () => {
  it('shows planned and focus sets against the guide, and the time estimates', () => {
    renderFocus(focusPlan({ sets: 6, seconds: 600, budget: { sets: 9, minutes: 20 } }));

    const summary = summarySection();
    expect(within(summary).getByText('Planned').nextSibling?.textContent).toBe('3 sets');
    expect(within(summary).getByText('Focus').nextSibling?.textContent).toBe('6 sets / 9 guide');
    // Standard preset: warm-up 10 + 30 + 90, two work sets 10 + 60 + 240 → 750 s, plus 600 s of focus.
    expect(within(summary).getByText('Estimated time').nextSibling?.textContent).toBe('23 min');
    expect(within(summary).getByText('Focus time').nextSibling?.textContent).toBe('10 min / 20 guide');
  });

  it('marks focus sets and time over the guide', () => {
    renderFocus(focusPlan({ sets: 12, seconds: 1800, over: true }));
    const summary = summarySection();
    expect(within(summary).getByText('Focus').nextSibling).toHaveClass('warnText');
    expect(within(summary).getByText('Focus time').nextSibling).toHaveClass('warnText');
  });
});

describe('FocusWorkout — placement', () => {
  it('puts focus work after the planned lifts by default', () => {
    renderFocus();
    expect(moduleOrder()).toEqual(['Workout Summary', 'Planned', 'Focus work']);
    expect(liftsIn('Planned')).toEqual(['SquatTM: 315 lbs', 'Bench PressTM: 285 lbs']);
    expect(liftsIn('Focus work')).toEqual(['Lateral Raise', 'Face Pull']);
  });

  it('puts focus work first when placed before', () => {
    renderFocus(focusPlan({ dayState: dayState({ placement: 'before' }) }));
    expect(moduleOrder()).toEqual(['Workout Summary', 'Focus work', 'Planned']);
  });

  it('saves a placement change without re-planning the day', async () => {
    renderFocus();
    await userEvent.click(screen.getByRole('radio', { name: 'Before' }));

    expect(moduleOrder()).toEqual(['Workout Summary', 'Focus work', 'Planned']);
    expect(mockedSave).toHaveBeenCalledWith('5-3-1', 1, dayState({ placement: 'before' }));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Before' })).toHaveAttribute('aria-checked', 'true');
  });

  it('swaps the modules when one is dragged onto the other', () => {
    renderFocus();
    const [planned, focus] = [
      screen.getByRole('region', { name: 'Planned' }),
      screen.getByRole('region', { name: 'Focus work' }),
    ];
    fireEvent.dragStart(focus, { dataTransfer: { effectAllowed: '' } });
    fireEvent.drop(planned);

    expect(moduleOrder()).toEqual(['Workout Summary', 'Focus work', 'Planned']);
    expect(mockedSave).toHaveBeenCalledWith('5-3-1', 1, dayState({ placement: 'before' }));
  });

  it('interleaves a focus lift after each planned lift, tagged with its area', () => {
    renderFocus(focusPlan({ dayState: dayState({ placement: 'interleave' }) }));

    expect(moduleOrder()).toEqual(['Workout Summary', 'Today’s order', 'Focus controls for today']);
    expect(liftsIn('Today’s order')).toEqual([
      'SquatTM: 315 lbs',
      'Lateral RaiseShoulders',
      'Bench PressTM: 285 lbs',
      'Face PullShoulders',
    ]);
    // The focus block's controls stay reachable without a list of their own.
    expect(screen.getByRole('combobox', { name: 'Shoulders selection today' })).toBeInTheDocument();
  });

  it('reorders with the arrow buttons and saves the order', async () => {
    renderFocus(focusPlan({ dayState: dayState({ placement: 'interleave' }) }));
    expect(screen.getByRole('button', { name: 'Move Squat up' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Move Lateral Raise up' }));

    const order = ['f:b-shoulders:Lateral Raise', 'p:Squat#0', 'p:Bench Press#0', 'f:b-shoulders:Face Pull'];
    expect(mockedSave).toHaveBeenCalledWith('5-3-1', 1, dayState({ placement: 'interleave', order }));
    expect(liftsIn('Today’s order')[0]).toBe('Lateral RaiseShoulders');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reorders by dragging a lift onto another', () => {
    renderFocus(focusPlan({ dayState: dayState({ placement: 'interleave' }) }));
    const section = screen.getByRole('region', { name: 'Today’s order' });
    const [first, , , fourth] = Array.from(section.querySelectorAll('[data-row-id]'));
    if (!first || !fourth) throw new Error('expected four rows');

    fireEvent.dragStart(fourth, { dataTransfer: { effectAllowed: '' } });
    fireEvent.drop(first);

    expect(liftsIn('Today’s order')).toEqual([
      'Face PullShoulders',
      'SquatTM: 315 lbs',
      'Lateral RaiseShoulders',
      'Bench PressTM: 285 lbs',
    ]);
  });

  it('follows a saved order and resets it', async () => {
    const order = ['p:Bench Press#0', 'f:b-shoulders:Face Pull', 'p:Squat#0', 'f:b-shoulders:Lateral Raise'];
    renderFocus(focusPlan({ dayState: dayState({ placement: 'interleave', order }) }));
    expect(liftsIn('Today’s order')[0]).toBe('Bench PressTM: 285 lbs');

    await userEvent.click(screen.getByRole('button', { name: 'Reset order' }));

    expect(liftsIn('Today’s order')[0]).toBe('SquatTM: 315 lbs');
    expect(mockedSave).toHaveBeenCalledWith('5-3-1', 1, dayState({ placement: 'interleave', order: null }));
    expect(screen.queryByRole('button', { name: 'Reset order' })).not.toBeInTheDocument();
  });
});

describe('FocusWorkout — over-guide advice', () => {
  const overPlan = () =>
    focusPlan({
      sets: 12,
      seconds: 1500,
      over: true,
      suggestion: { blockId: 'b-shoulders', lift: 'Face Pull', sets: 9, seconds: 1080 },
    });

  it('suggests trimming the lowest-priority lift', () => {
    renderFocus(overPlan());
    const advice = screen.getByRole('region', { name: 'Focus guide advice' });
    expect(advice).toHaveTextContent(
      '12 of 9 sets, 25 of 20 min. Shoulders is your lowest priority; trimming Face Pull brings today to 9 sets, 18 min.',
    );
  });

  it('trims the suggested lift and re-plans the day', async () => {
    renderFocus(overPlan());
    await userEvent.click(screen.getByRole('button', { name: 'Trim Face Pull' }));

    expect(mockedSave).toHaveBeenCalledWith('5-3-1', 1, dayState({ trims: { 'b-shoulders': ['Face Pull'] } }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByText(/Trimmed today: Face Pull\./)).toBeInTheDocument();
  });

  it('undoes the day’s trims', async () => {
    renderFocus(
      focusPlan({
        dayState: dayState({ trims: { 'b-shoulders': ['Face Pull'] } }),
        groups: [planGroup({ items: [planItem('Lateral Raise')], trimmed: ['Face Pull'] })],
      }),
    );
    expect(screen.getByText(/trimmed for today/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));

    expect(mockedSave).toHaveBeenCalledWith('5-3-1', 1, dayState({ trims: {} }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('keeps everything, and can bring the suggestion back', async () => {
    renderFocus(overPlan());
    await userEvent.click(screen.getByRole('button', { name: 'Keep everything' }));

    expect(screen.queryByRole('region', { name: 'Focus guide advice' })).not.toBeInTheDocument();
    expect(screen.getByText(/Over the guide; keeping everything\./)).toBeInTheDocument();
    expect(mockedSave).toHaveBeenLastCalledWith('5-3-1', 1, dayState({ dismissed: true }));
    expect(refresh).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Show suggestion' }));
    expect(screen.getByRole('region', { name: 'Focus guide advice' })).toBeInTheDocument();
    expect(mockedSave).toHaveBeenLastCalledWith('5-3-1', 1, dayState({ dismissed: false }));
  });

  it('shows no advice under the guide', () => {
    renderFocus();
    expect(screen.queryByRole('region', { name: 'Focus guide advice' })).not.toBeInTheDocument();
  });
});

describe('FocusWorkout — focus block controls', () => {
  it('overrides the selection mode for today and re-plans', async () => {
    renderFocus();
    const select = screen.getByRole('combobox', { name: 'Shoulders selection today' });
    expect(select).toHaveValue('');
    expect(within(select).getByRole('option', { name: 'Focus block default (Rules)' })).toBeInTheDocument();

    await userEvent.selectOptions(select, 'rotate');
    expect(mockedSave).toHaveBeenLastCalledWith('5-3-1', 1, dayState({ modes: { 'b-shoulders': 'rotate' } }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('clears an override back to the focus block default', async () => {
    renderFocus(focusPlan({ dayState: dayState({ modes: { 'b-shoulders': 'fixed' } }) }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Shoulders selection today' }), '');
    expect(mockedSave).toHaveBeenLastCalledWith('5-3-1', 1, dayState({ modes: {} }));
  });

  it('toggles pick chips', async () => {
    renderFocus(
      focusPlan({
        dayState: dayState({ picks: { 'b-shoulders': ['Lateral Raise'] } }),
        groups: [
          planGroup({
            mode: 'pick',
            items: [planItem('Lateral Raise')],
            suggestions: [poolEntry('Lateral Raise'), poolEntry('Face Pull')],
          }),
        ],
      }),
    );
    expect(screen.getByRole('button', { name: '✓ Lateral Raise' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: '+ Face Pull' }));
    expect(mockedSave).toHaveBeenLastCalledWith(
      '5-3-1',
      1,
      dayState({ picks: { 'b-shoulders': ['Lateral Raise', 'Face Pull'] } }),
    );
  });

  it('explains overlap, skipped lifts and a reduced lift', () => {
    renderFocus(
      focusPlan({
        groups: [
          planGroup({
            overlap: { lifts: ['Bench Press'], mode: 'reduce' },
            items: [planItem('Lateral Raise', 2, { reducedFrom: 3 })],
            skipped: [{ lift: 'Arnold Press', reason: 'rule', detail: 'Overhead Press' }],
          }),
        ],
      }),
    );
    expect(screen.getByText('Bench Press trains shoulders today, so one set fewer per lift.')).toBeInTheDocument();
    expect(screen.getByText('Arnold Press').parentElement).toHaveTextContent(
      'Arnold Press skipped: your rule: Overhead Press is planned',
    );
    expect(screen.getByText('Reduced 3 → 2 sets: Bench Press trains shoulders today')).toBeInTheDocument();
  });

  it('shows each focus lift’s prescription when expanded', async () => {
    renderFocus(focusPlan({ groups: [planGroup({ block: focusBlock(), items: [planItem('Lateral Raise')] })] }));
    await userEvent.click(screen.getByRole('button', { name: /Lateral Raise/ }));

    expect(screen.getByText('Focus sets · Double progression')).toBeInTheDocument();
    expect(screen.getAllByText('10–12 reps @ 25 lbs')).toHaveLength(3);
    expect(
      screen.getByText('Hit 12 on every set and the weight goes up next time. Timer: 0:10 setup · 0:45 set · 1:00 rest.'),
    ).toBeInTheDocument();
  });
});

describe('FocusWorkout — a failed save', () => {
  it('logs the error, reverts the change and says so', async () => {
    const err = new Error('API down');
    mockedSave.mockRejectedValue(err);
    renderFocus();

    await userEvent.click(screen.getByRole('radio', { name: 'Interleave' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save your focus work changes.');
    expect(mockedLog).toHaveBeenCalledWith('saveFocusDayState', err, { program: '5-3-1', macrocycleNum: 1, workoutNum: 1 });
    expect(moduleOrder()).toEqual(['Workout Summary', 'Planned', 'Focus work']);
  });
});
