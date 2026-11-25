import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_WEIGHT_INCREMENT, type CustomLiftResponse } from '@lifting-logbook/types';
import TrainingMaxesForm from './TrainingMaxesForm';
import { saveTrainingMaxes } from './actions';

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

describe('TrainingMaxesForm row names (#1291)', () => {
  it("names each row by its lift's name and saves under the stored lift", async () => {
    const user = userEvent.setup();
    const save = saveTrainingMaxes as jest.Mock;
    save.mockReset().mockResolvedValue([]);
    const customId = '6f1c2e0a-9b7d-4c1e-8a2f-3d5b7c9e1f20';
    const bench = { lift: 'bench-press', weight: 200, unit: 'lbs', dateUpdated: '2026-10-01' } as const;
    const custom = { lift: customId, weight: 60, unit: 'lbs', dateUpdated: '2026-10-02' } as const;
    render(
      <TrainingMaxesForm
        program="5-3-1"
        lifts={['bench-press', customId]}
        maxes={[bench, custom]}
        customLifts={[{ id: customId, name: 'Zercher Squat' } as CustomLiftResponse]}
        increments={{}}
      />,
    );

    expect(screen.getByRole('cell', { name: 'Bench Press' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Zercher Squat' })).toBeInTheDocument();
    expect(screen.queryByText('bench-press')).not.toBeInTheDocument();
    expect(screen.queryByText(customId)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Zercher Squat training max')).toHaveValue(60);

    const input = screen.getByLabelText('Bench Press training max');
    await user.clear(input);
    await user.type(input, '205');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(save).toHaveBeenCalledWith('5-3-1', {
      maxes: [
        { lift: 'bench-press', weight: 205, unit: 'lbs' },
        { lift: customId, weight: 60, unit: 'lbs' },
      ],
    });
  });

  it('keeps two rows apart when they store two spellings of one lift', () => {
    const byId = { lift: 'bench-press', weight: 200, unit: 'lbs', dateUpdated: '2026-10-01' } as const;
    const byName = { lift: 'Bench Press', weight: 190, unit: 'lbs', dateUpdated: '2025-01-01' } as const;
    render(
      <TrainingMaxesForm
        program="5-3-1"
        lifts={['bench-press', 'Bench Press']}
        maxes={[byId, byName]}
        increments={{}}
      />,
    );

    expect(screen.getByLabelText('Bench Press (bench-press) training max')).toHaveValue(200);
    expect(screen.getByLabelText('Bench Press (Bench Press) training max')).toHaveValue(190);
  });
});
