import { render, screen, waitFor } from '@testing-library/react';
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

  it('deletes the goal under the name it is stored as', async () => {
    const user = userEvent.setup();
    renderForm([max('Bench Press')], [goal('bench-press')]);
    await user.click(screen.getByRole('button', { name: /(delete|remove)/i }));
    await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledWith('5-3-1', 'bench-press'));
  });

  it('keeps a goal on one name off a max under another name for that lift', () => {
    renderForm([max('Lateral Raise')], [goal('C. Lat Raise')]);
    expect(screen.queryByText(/of goal/)).not.toBeInTheDocument();
  });
});
