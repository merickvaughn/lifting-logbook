import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomLiftResponse, StrengthGoalResponse, TrainingMaxResponse } from '@lifting-logbook/types';
import { logClientError } from '@/lib/log-client-error';
import StrengthGoalsForm from './StrengthGoalsForm';
import { removeStrengthGoal } from './actions';

jest.mock('./actions', () => ({
  saveStrengthGoal: jest.fn(),
  removeStrengthGoal: jest.fn(),
  saveBodyWeight: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const SQUAT_TM: TrainingMaxResponse = {
  lift: 'Back Squat',
  weight: 100,
  unit: 'lbs',
  dateUpdated: '2026-06-01',
};

describe('StrengthGoalsForm — cross-unit progress', () => {
  // 45.359237 kg is the exact conversion of 100 lbs, so a correctly unit-aware
  // comparison lands at exactly 100%. Before the cross-unit fix, the training max
  // (100, implicitly lbs) was compared directly against the body weight/target
  // number without converting units first, which would have shown ~220% here
  // instead — this test pins the correct behavior and would catch a regression.
  it('converts the training max into the body-weight unit for a relative goal', () => {
    const goals: StrengthGoalResponse[] = [
      { lift: 'Back Squat', goalType: 'relative', ratio: 1, unit: 'kg', updatedAt: '2026-06-01' },
    ];
    render(
      <StrengthGoalsForm
        program="5-3-1"
        trainingMaxes={[SQUAT_TM]}
        goals={goals}
        bodyWeight={{ date: '2026-06-01', weight: 45.359237, unit: 'kg' }}
        preferredUnit="kg"
        customLifts={[]}
      />,
    );

    expect(screen.getByText(/100% of goal/)).toBeInTheDocument();
  });

  it('converts the training max into the target unit for an absolute goal', () => {
    const goals: StrengthGoalResponse[] = [
      { lift: 'Back Squat', goalType: 'absolute', target: 45.359237, unit: 'kg', updatedAt: '2026-06-01' },
    ];
    render(
      <StrengthGoalsForm
        program="5-3-1"
        trainingMaxes={[SQUAT_TM]}
        goals={goals}
        bodyWeight={{ date: '2026-06-01', weight: 70, unit: 'kg' }}
        preferredUnit="kg"
        customLifts={[]}
      />,
    );

    expect(screen.getByText(/100% of goal/)).toBeInTheDocument();
  });

  it('shows the current training max converted to the preferred unit', () => {
    render(
      <StrengthGoalsForm
        program="5-3-1"
        trainingMaxes={[SQUAT_TM]}
        goals={[]}
        bodyWeight={null}
        preferredUnit="kg"
        customLifts={[]}
      />,
    );

    // 100 lbs -> 45.36 kg.
    expect(screen.getByText(/Current max: 45\.36 kg/)).toBeInTheDocument();
  });

  it('defaults a new goal row to the preferred unit', () => {
    render(
      <StrengthGoalsForm
        program="5-3-1"
        trainingMaxes={[SQUAT_TM]}
        goals={[]}
        bodyWeight={null}
        preferredUnit="kg"
        customLifts={[]}
      />,
    );

    // New rows default to the 'relative' goal type, whose unit select shares
    // the same aria-label as the 'absolute' branch's.
    expect(screen.getByLabelText('Unit for Back Squat')).toHaveValue('kg');
  });
});

// #1179: a goal no card reaches is listed under the cards, so it can be seen and removed.
describe('StrengthGoalsForm — goals with no card', () => {
  beforeEach(() => jest.clearAllMocks());

  const KEPT_LIFT: CustomLiftResponse = {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    name: 'Squat (custom)',
    classification: 'compound',
    movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
    isBodyweightComponent: false,
    isCustom: true,
    createdAt: '2026-06-01',
  };

  function renderForm(goals: StrengthGoalResponse[], customLifts: CustomLiftResponse[] = []) {
    render(
      <StrengthGoalsForm
        program="5-3-1"
        trainingMaxes={[SQUAT_TM]}
        goals={goals}
        bodyWeight={null}
        preferredUnit="lbs"
        customLifts={customLifts}
      />,
    );
  }

  const otherGoals = () => within(screen.getByRole('list'));

  it('lists a goal on a lift with no training max, with its lift and target', () => {
    renderForm([
      { lift: 'Deadlift', goalType: 'absolute', target: 405, unit: 'lbs', updatedAt: '2026-06-01' },
      { lift: 'Overhead Press', goalType: 'relative', ratio: 0.75, unit: 'lbs', updatedAt: '2026-06-01' },
    ]);
    expect(otherGoals().getByText('Deadlift')).toBeInTheDocument();
    expect(otherGoals().getByText('Goal: 405 lbs')).toBeInTheDocument();
    expect(otherGoals().getByText('Overhead Press')).toBeInTheDocument();
    expect(otherGoals().getByText('Goal: 0.75× BW')).toBeInTheDocument();
  });

  it('lists nothing when every goal has a card', () => {
    renderForm([{ lift: 'Back Squat', goalType: 'absolute', target: 300, unit: 'lbs', updatedAt: '2026-06-01' }]);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('names a custom lift\'s goal by the lift\'s name, not its id', () => {
    renderForm(
      [{ lift: KEPT_LIFT.id, goalType: 'absolute', target: 300, unit: 'lbs', updatedAt: '2026-06-01' }],
      [KEPT_LIFT],
    );
    expect(otherGoals().getByText('Squat (custom)')).toBeInTheDocument();
    expect(screen.queryByText(KEPT_LIFT.id)).not.toBeInTheDocument();
  });

  it('removes a listed goal under its stored lift, and it leaves the list', async () => {
    const user = userEvent.setup();
    (removeStrengthGoal as jest.Mock).mockResolvedValue(undefined);
    renderForm(
      [{ lift: KEPT_LIFT.id, goalType: 'absolute', target: 300, unit: 'lbs', updatedAt: '2026-06-01' }],
      [KEPT_LIFT],
    );
    await user.click(screen.getByRole('button', { name: 'Remove goal for Squat (custom)' }));
    await waitFor(() => expect(removeStrengthGoal).toHaveBeenCalledWith('5-3-1', KEPT_LIFT.id));
    await waitFor(() => expect(screen.queryByText('Squat (custom)')).not.toBeInTheDocument());
  });

  it('keeps a goal listed, reports the error and says so when removing it fails', async () => {
    const user = userEvent.setup();
    const failure = new Error('API 500');
    (removeStrengthGoal as jest.Mock).mockRejectedValue(failure);
    renderForm([{ lift: 'Deadlift', goalType: 'absolute', target: 405, unit: 'lbs', updatedAt: '2026-06-01' }]);
    await user.click(screen.getByRole('button', { name: 'Remove goal for Deadlift' }));
    expect(await screen.findByText('Remove failed')).toBeInTheDocument();
    expect(otherGoals().getByText('Deadlift')).toBeInTheDocument();
    expect(logClientError).toHaveBeenCalledWith('removeStrengthGoal', failure, { program: '5-3-1', lift: 'Deadlift' });
  });

  it('names a custom lift\'s card by the lift\'s name', () => {
    render(
      <StrengthGoalsForm
        program="5-3-1"
        trainingMaxes={[{ ...SQUAT_TM, lift: KEPT_LIFT.id }]}
        goals={[]}
        bodyWeight={null}
        preferredUnit="lbs"
        customLifts={[KEPT_LIFT]}
      />,
    );
    expect(screen.getByText('Squat (custom)')).toBeInTheDocument();
    expect(screen.getByLabelText('Body weight ratio for Squat (custom)')).toBeInTheDocument();
  });
});
