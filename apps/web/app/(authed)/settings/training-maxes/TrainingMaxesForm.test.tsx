import { render, screen } from '@testing-library/react';
import { DEFAULT_WEIGHT_INCREMENT } from '@lifting-logbook/types';
import TrainingMaxesForm from './TrainingMaxesForm';

jest.mock('./actions', () => ({
  saveTrainingMaxes: jest.fn(),
}));

describe('TrainingMaxesForm across stored spellings (#1135)', () => {
  it('fills the Bench Press row from a max stored as bench-press', () => {
    render(
      <TrainingMaxesForm
        program="5-3-1"
        lifts={['Bench Press']}
        maxes={[{ lift: 'bench-press', weight: 200, unit: 'lbs', dateUpdated: '2026-06-01' }]}
        increments={{}}
      />,
    );

    expect(screen.getByLabelText('Bench Press training max')).toHaveValue(200);
  });
});

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
