import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StrengthGoalResponse, TrainingMaxResponse } from '@lifting-logbook/types';
import StrengthGoalsForm from './StrengthGoalsForm';
import { removeStrengthGoal, saveStrengthGoal } from './actions';

jest.mock('./actions', () => ({
  saveStrengthGoal: jest.fn(),
  removeStrengthGoal: jest.fn(),
  saveBodyWeight: jest.fn(),
}));

const max = (lift: string): TrainingMaxResponse => ({ lift, weight: 100, unit: 'lbs', dateUpdated: '2026-06-01' });
const goal = (lift: string): StrengthGoalResponse => ({
  lift,
  goalType: 'absolute',
  target: 200,
  unit: 'lbs',
  updatedAt: '2026-06-01',
});

function renderForm(trainingMaxes: TrainingMaxResponse[], goals: StrengthGoalResponse[]) {
  render(
    <StrengthGoalsForm
      program="5-3-1"
      trainingMaxes={trainingMaxes}
      goals={goals}
      bodyWeight={{ date: '2026-06-01', weight: 100, unit: 'lbs' }}
      preferredUnit="lbs"
      customLifts={[]}
    />,
  );
}

// #1135: a goal stored under another spelling belongs on its max's row.
describe('StrengthGoalsForm across stored spellings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows a bench-press goal on the Bench Press row', () => {
    renderForm([max('Bench Press')], [goal('bench-press')]);
    expect(screen.getByText(/50% of goal/)).toBeInTheDocument();
  });

  it('shows a Bench Press goal on a bench-press row', () => {
    renderForm([max('bench-press')], [goal('Bench Press')]);
    expect(screen.getByText(/50% of goal/)).toBeInTheDocument();
  });

  it('saves under the name the goal is stored as, rather than adding a second goal', async () => {
    const user = userEvent.setup();
    renderForm([max('Bench Press')], [goal('bench-press')]);
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveStrengthGoal).toHaveBeenCalled());
    expect(saveStrengthGoal).toHaveBeenCalledWith('5-3-1', 'bench-press', expect.anything());
  });

  describe('two rows reaching one goal', () => {
    it('updates both when one saves, so the other can\'t write the old value back', async () => {
      const user = userEvent.setup();
      renderForm([max('Bench Press'), max('bench-press')], [goal('Bench Press')]);
      const target = screen.getByLabelText('Target weight for Bench Press');
      await user.clear(target);
      await user.type(target, '250');
      await user.click(screen.getAllByRole('button', { name: /save/i })[0] as HTMLElement);
      await waitFor(() => expect(saveStrengthGoal).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByLabelText('Target weight for bench-press')).toHaveValue(250));
    });

    it('clears both when one deletes, so the other offers no second delete', async () => {
      const user = userEvent.setup();
      renderForm([max('Bench Press'), max('bench-press')], [goal('Bench Press')]);
      expect(screen.getAllByRole('button', { name: /(delete|remove)/i })).toHaveLength(2);
      await user.click(screen.getAllByRole('button', { name: /(delete|remove)/i })[0] as HTMLElement);
      await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /(delete|remove)/i })).not.toBeInTheDocument(),
      );
    });

    it('disables both while one deletes, so the other can\'t delete a goal already gone', async () => {
      const user = userEvent.setup();
      let finish: () => void = () => undefined;
      (removeStrengthGoal as jest.Mock).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
      renderForm([max('Bench Press'), max('bench-press')], [goal('Bench Press')]);
      const [first, second] = screen.getAllByRole('button', { name: /(delete|remove)/i });
      await user.click(first as HTMLElement);
      expect(second).toBeDisabled();
      finish();
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /(delete|remove)/i })).not.toBeInTheDocument(),
      );
    });

    it('leaves a row with its own goal alone', async () => {
      const user = userEvent.setup();
      (removeStrengthGoal as jest.Mock).mockResolvedValue(undefined);
      renderForm([max('Bench Press'), max('Deadlift')], [goal('Bench Press'), goal('Deadlift')]);
      await user.click(screen.getAllByRole('button', { name: /(delete|remove)/i })[0] as HTMLElement);
      await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledWith('5-3-1', 'Bench Press'));
      await waitFor(() => expect(screen.getAllByRole('button', { name: /(delete|remove)/i })).toHaveLength(1));
      expect(screen.getByLabelText('Target weight for Deadlift')).toHaveValue(200);
    });

    it('shows the goal a row still reaches after its own is deleted', async () => {
      const user = userEvent.setup();
      (removeStrengthGoal as jest.Mock).mockResolvedValue(undefined);
      const other: StrengthGoalResponse = { ...goal('Bench Press'), target: 300 };
      renderForm([max('Bench Press'), max('bench-press')], [other, goal('bench-press')]);
      await user.click(screen.getAllByRole('button', { name: /(delete|remove)/i })[1] as HTMLElement);
      await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledWith('5-3-1', 'bench-press'));
      await waitFor(() => expect(screen.getByLabelText('Target weight for bench-press')).toHaveValue(300));
      expect(screen.getAllByRole('button', { name: /(delete|remove)/i })).toHaveLength(2);
    });
  });

  it('deletes the goal under the name it is stored as', async () => {
    const user = userEvent.setup();
    renderForm([max('Bench Press')], [goal('bench-press')]);
    await user.click(screen.getByRole('button', { name: /(delete|remove)/i }));
    await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledWith('5-3-1', 'bench-press'));
  });

  it('keeps a goal on one name off a max under another name for that lift', () => {
    renderForm([max('Lateral Raise')], [goal('C. Lat Raise')]);
    expect(screen.queryByText(/of goal/)).not.toBeInTheDocument();
    // #1179: it is listed under the cards instead.
    expect(within(screen.getByRole('list')).getByText('C. Lat Raise')).toBeInTheDocument();
  });

  // #1179: a card reads one goal, so a second spelling's goal is listed under the cards.
  describe('a goal hidden behind another spelling', () => {
    const backSquat: StrengthGoalResponse = { ...goal('Back Squat'), target: 300 };

    it('is listed, while the card shows its own spelling\'s goal', () => {
      renderForm([max('back-squat')], [goal('back-squat'), backSquat]);
      expect(screen.getByLabelText('Target weight for back-squat')).toHaveValue(200);
      const listed = within(screen.getByRole('list'));
      expect(listed.getByText('Back Squat')).toBeInTheDocument();
      expect(listed.getByText('Goal: 300 lbs')).toBeInTheDocument();
    });

    it('is removed under its own stored lift, leaving the card\'s goal alone', async () => {
      const user = userEvent.setup();
      (removeStrengthGoal as jest.Mock).mockResolvedValue(undefined);
      renderForm([max('back-squat')], [goal('back-squat'), backSquat]);
      await user.click(screen.getByRole('button', { name: 'Remove goal for Back Squat' }));
      await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledWith('5-3-1', 'Back Squat'));
      await waitFor(() => expect(screen.queryByRole('list')).not.toBeInTheDocument());
      expect(screen.getByLabelText('Target weight for back-squat')).toHaveValue(200);
    });

    it('moves onto the card once the card\'s own goal is removed', async () => {
      const user = userEvent.setup();
      (removeStrengthGoal as jest.Mock).mockResolvedValue(undefined);
      renderForm([max('back-squat')], [goal('back-squat'), backSquat]);
      await user.click(screen.getByRole('button', { name: '✕ Remove' }));
      await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledWith('5-3-1', 'back-squat'));
      await waitFor(() => expect(screen.getByLabelText('Target weight for back-squat')).toHaveValue(300));
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
    });

    it('saves the card under the goal it now shows, rather than the one it removed', async () => {
      const user = userEvent.setup();
      (removeStrengthGoal as jest.Mock).mockResolvedValue(undefined);
      renderForm([max('back-squat')], [goal('back-squat'), backSquat]);
      await user.click(screen.getByRole('button', { name: '✕ Remove' }));
      await waitFor(() => expect(screen.getByLabelText('Target weight for back-squat')).toHaveValue(300));
      await user.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(saveStrengthGoal).toHaveBeenCalledWith('5-3-1', 'Back Squat', expect.anything()));
    });
  });
});
