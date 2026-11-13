import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_WEIGHT_INCREMENT } from '@lifting-logbook/types';
import TrainingMaxesForm from './TrainingMaxesForm';

jest.mock('./actions', () => ({
  saveTrainingMaxes: jest.fn(),
}));

describe('TrainingMaxesForm step increment', () => {
  it("sets each lift's number-input step to its configured increment", () => {
    render(
      <TrainingMaxesForm
        program="5-3-1"
        lifts={['Squat', 'Weighted Pull-ups']}
        maxes={[]}
        increments={{ Squat: 10, 'Weighted Pull-ups': 2.5 }}
      />,
    );

    expect(screen.getByLabelText('Squat training max')).toHaveAttribute(
      'step',
      '10',
    );
    expect(
      screen.getByLabelText('Weighted Pull-ups training max'),
    ).toHaveAttribute('step', '2.5');
  });

  it('falls back to DEFAULT_WEIGHT_INCREMENT when a lift has no resolved increment', () => {
    render(
      <TrainingMaxesForm
        program="5-3-1"
        lifts={['Deadlift']}
        maxes={[]}
        increments={{}}
      />,
    );

    expect(screen.getByLabelText('Deadlift training max')).toHaveAttribute(
      'step',
      String(DEFAULT_WEIGHT_INCREMENT),
    );
  });
});

describe('TrainingMaxesForm when a lift joins the list (#1246)', () => {
  it('adds a row for the new lift and keeps unsaved edits in the others', async () => {
    const user = userEvent.setup();
    const squat = { lift: 'Squat', weight: 300, unit: 'lbs', dateUpdated: '2026-10-01' } as const;
    const { rerender } = render(
      <TrainingMaxesForm program="5-3-1" lifts={['Squat']} maxes={[squat]} increments={{}} />,
    );
    const input = screen.getByLabelText('Squat training max');
    await user.clear(input);
    await user.type(input, '305');

    const rdl = { lift: 'Romanian Deadlift', weight: 100, unit: 'lbs', dateUpdated: '2026-11-13' } as const;
    rerender(
      <TrainingMaxesForm
        program="5-3-1"
        lifts={['Squat', 'Romanian Deadlift']}
        maxes={[squat, rdl]}
        increments={{}}
      />,
    );

    expect(screen.getByLabelText('Squat training max')).toHaveValue(305);
    expect(screen.getByLabelText('Romanian Deadlift training max')).toHaveValue(100);
  });
});
