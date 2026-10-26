import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyFocusDayState, type FocusDayPlanResponse, type FocusDayState } from '@lifting-logbook/types';
import { focusRowIds, plannedRowIds } from '@/lib/focusWorkout';
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

const [SQUAT_ID = '', BENCH_ID = ''] = plannedRowIds(['Squat', 'Bench Press']);
const [LATERAL_ID = '', FACE_ID = ''] = focusRowIds('b-shoulders', ['Lateral Raise', 'Face Pull']);

/** jsdom has no DataTransfer; the handlers only set and read its data. */
const DRAG = { dataTransfer: { effectAllowed: '', setData: jest.fn(), getData: () => '' } };

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

/** Saves run from a queue, so the request goes out a microtask after the click. */
async function expectSaved(state: FocusDayState) {
  await waitFor(() => expect(mockedSave).toHaveBeenLastCalledWith('5-3-1', 1, state));
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

  it('marks focus time over the guide by the seconds, as the API does, not the rounded minutes', () => {
    // 20 min 20 s rounds to "20 min", but it is over a 20-minute guide.
    renderFocus(focusPlan({ sets: 6, seconds: 1220, over: true }));
    expect(within(summarySection()).getByText('Focus time').nextSibling).toHaveClass('warnText');
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
    await expectSaved(dayState({ placement: 'before' }));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Before' })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves through the placements with the arrow keys, one tab stop for the group', async () => {
    renderFocus();
    const after = screen.getByRole('radio', { name: 'After' });
    expect(after).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Before' })).toHaveAttribute('tabindex', '-1');

    after.focus();
    await userEvent.keyboard('{ArrowRight}');

    const interleave = screen.getByRole('radio', { name: 'Interleave' });
    expect(interleave).toHaveAttribute('aria-checked', 'true');
    expect(interleave).toHaveFocus();
    await expectSaved(dayState({ placement: 'interleave' }));

    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Before' })).toHaveAttribute('aria-checked', 'true');
  });

  it('swaps the modules when one is dragged onto the other by its grip', async () => {
    renderFocus();
    const planned = screen.getByRole('region', { name: 'Planned' });
    const focus = screen.getByRole('region', { name: 'Focus work' });

    fireEvent.dragStart(within(focus).getByTitle('Drag to move'), DRAG);
    fireEvent.drop(planned);

    expect(moduleOrder()).toEqual(['Workout Summary', 'Focus work', 'Planned']);
    expect(DRAG.dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'focus');
    await expectSaved(dayState({ placement: 'before' }));
  });

  it('ignores a drag that starts inside a module but not on its grip', () => {
    renderFocus();
    const planned = screen.getByRole('region', { name: 'Planned' });
    const focus = screen.getByRole('region', { name: 'Focus work' });

    const [historyLink] = within(planned).getAllByRole('link', { name: /History/ });
    if (!historyLink) throw new Error('expected a History link');
    fireEvent.dragStart(historyLink, DRAG);
    fireEvent.drop(focus);

    expect(moduleOrder()).toEqual(['Workout Summary', 'Planned', 'Focus work']);
    expect(mockedSave).not.toHaveBeenCalled();
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

    await expectSaved(dayState({ placement: 'interleave', order: [LATERAL_ID, SQUAT_ID, BENCH_ID, FACE_ID] }));
    expect(liftsIn('Today’s order')[0]).toBe('Lateral RaiseShoulders');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps keyboard focus on the moved row, and announces where it went', async () => {
    renderFocus(focusPlan({ dayState: dayState({ placement: 'interleave' }) }));

    await userEvent.click(screen.getByRole('button', { name: 'Move Lateral Raise up' }));

    // At the top its ↑ is disabled, so focus goes to its ↓ rather than to <body>.
    expect(screen.getByRole('button', { name: 'Move Lateral Raise up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Lateral Raise down' })).toHaveFocus();
    expect(screen.getByText('Lateral Raise moved to position 1 of 4')).toBeInTheDocument();
  });

  it('reorders by dragging a lift onto another by its grip', () => {
    renderFocus(focusPlan({ dayState: dayState({ placement: 'interleave' }) }));
    const section = screen.getByRole('region', { name: 'Today’s order' });
    const [first, , , fourth] = Array.from(section.querySelectorAll('[data-row-id]'));
    const grip = fourth?.querySelector('[title="Drag to reorder"]');
    if (!first || !grip) throw new Error('expected four rows with grips');

    fireEvent.dragStart(grip, DRAG);
    fireEvent.drop(first);

    expect(liftsIn('Today’s order')).toEqual([
      'Face PullShoulders',
      'SquatTM: 315 lbs',
      'Lateral RaiseShoulders',
      'Bench PressTM: 285 lbs',
    ]);
    expect(DRAG.dataTransfer.setData).toHaveBeenCalledWith('text/plain', FACE_ID);
  });

  it('follows a saved order and resets it', async () => {
    const order = [BENCH_ID, FACE_ID, SQUAT_ID, LATERAL_ID];
    renderFocus(focusPlan({ dayState: dayState({ placement: 'interleave', order }) }));
    expect(liftsIn('Today’s order')[0]).toBe('Bench PressTM: 285 lbs');

    await userEvent.click(screen.getByRole('button', { name: 'Reset order' }));

    expect(liftsIn('Today’s order')[0]).toBe('SquatTM: 315 lbs');
    await expectSaved(dayState({ placement: 'interleave', order: null }));
    expect(screen.queryByRole('button', { name: 'Reset order' })).not.toBeInTheDocument();
  });

  it('renders the same lift twice in a focus block as two rows', () => {
    renderFocus(
      focusPlan({
        dayState: dayState({ placement: 'interleave' }),
        groups: [planGroup({ items: [planItem('Lateral Raise'), planItem('Lateral Raise')] })],
      }),
    );
    expect(liftsIn('Today’s order').filter((name) => name.startsWith('Lateral Raise'))).toHaveLength(2);
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

    await expectSaved(dayState({ trims: { 'b-shoulders': ['Face Pull'] } }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('trims once however often Trim is clicked while the save is in flight', async () => {
    let resolveSave: (state: FocusDayState) => void = () => undefined;
    mockedSave.mockImplementation(
      (_p: string, _w: number, body: FocusDayState) =>
        new Promise<FocusDayState>((resolve) => {
          resolveSave = () => resolve(body);
        }),
    );
    renderFocus(overPlan());
    const trim = screen.getByRole('button', { name: 'Trim Face Pull' });

    fireEvent.click(trim);
    fireEvent.click(trim);

    expect(trim).toBeDisabled();
    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(1));
    await act(async () => resolveSave(dayState()));
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith('5-3-1', 1, dayState({ trims: { 'b-shoulders': ['Face Pull'] } }));
  });

  it('lists only the trims the plan applies, and undoes them', async () => {
    // Face Pull is still in the saved trims but no longer selected (another mode
    // skips it), so the plan reports no trim for it and neither does the page.
    renderFocus(
      focusPlan({
        dayState: dayState({ trims: { 'b-shoulders': ['Face Pull', 'Arnold Press'] } }),
        groups: [planGroup({ items: [planItem('Lateral Raise')], trimmed: ['Arnold Press'] })],
      }),
    );
    expect(screen.getByText(/Trimmed today: Arnold Press\./)).toBeInTheDocument();
    expect(screen.queryByText(/Trimmed today:.*Face Pull/)).not.toBeInTheDocument();
    expect(screen.getByText(/trimmed for today/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await expectSaved(dayState({ trims: {} }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('keeps everything, and can bring the suggestion back', async () => {
    renderFocus(overPlan());
    await userEvent.click(screen.getByRole('button', { name: 'Keep everything' }));

    expect(screen.queryByRole('region', { name: 'Focus guide advice' })).not.toBeInTheDocument();
    expect(screen.getByText(/Over the guide; keeping everything\./)).toBeInTheDocument();
    await expectSaved(dayState({ dismissed: true }));
    expect(refresh).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Show suggestion' }));
    expect(screen.getByRole('region', { name: 'Focus guide advice' })).toBeInTheDocument();
    await expectSaved(dayState({ dismissed: false }));
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
    await expectSaved(dayState({ modes: { 'b-shoulders': 'rotate' } }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('clears an override back to the focus block default', async () => {
    renderFocus(focusPlan({ dayState: dayState({ modes: { 'b-shoulders': 'fixed' } }) }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Shoulders selection today' }), '');
    await expectSaved(dayState({ modes: {} }));
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
    await expectSaved(dayState({ picks: { 'b-shoulders': ['Lateral Raise', 'Face Pull'] } }));
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

  it('does not revert a later change that saved, nor skip its re-plan, when an earlier save fails', async () => {
    // The earlier change (a re-planning mode override) fails; the later layout change
    // carries it and succeeds, so the page keeps both, re-plans, and shows no error.
    const err = new Error('flaky');
    mockedSave
      .mockImplementationOnce(async () => {
        throw err;
      })
      .mockImplementationOnce(async (_p: string, _w: number, body: FocusDayState) => body);
    renderFocus();

    fireEvent.change(screen.getByRole('combobox', { name: 'Shoulders selection today' }), {
      target: { value: 'fixed' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Before' }));

    await waitFor(() => expect(mockedSave).toHaveBeenCalledTimes(2));
    expect(mockedSave).toHaveBeenLastCalledWith('5-3-1', 1, dayState({ modes: { 'b-shoulders': 'fixed' }, placement: 'before' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(moduleOrder()).toEqual(['Workout Summary', 'Focus work', 'Planned']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockedLog).toHaveBeenCalledWith('saveFocusDayState', err, expect.any(Object));
  });
});
