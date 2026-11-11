import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WeightIncrementForm from './WeightIncrementForm';
import { saveWeightIncrement } from './actions';

jest.mock('./actions', () => ({
  saveWeightIncrement: jest.fn(),
}));

const mockSave = saveWeightIncrement as jest.MockedFunction<typeof saveWeightIncrement>;

describe('WeightIncrementForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults the select to 1.25 when no increment is set yet', () => {
    render(<WeightIncrementForm initialIncrement={null} />);
    expect(screen.getByLabelText('Rounding increment')).toHaveValue('1.25');
  });

  it('preselects the stored increment', () => {
    render(<WeightIncrementForm initialIncrement={0.625} />);
    expect(screen.getByLabelText('Rounding increment')).toHaveValue('0.625');
  });

  it('lists exactly the four allowed increments', () => {
    render(<WeightIncrementForm initialIncrement={null} />);
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['0.625', '1.25', '2.5', '5']);
  });

  it('saves the selected increment and shows a confirmation', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue({
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: 5,
      unit: null,
      defaultProgression: null,
    });

    render(<WeightIncrementForm initialIncrement={1.25} />);
    await user.selectOptions(screen.getByLabelText('Rounding increment'), '5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(5));
    expect(await screen.findByText(/^Saved at /)).toBeInTheDocument();
  });

  it('shows an error message when the save fails', async () => {
    const user = userEvent.setup();
    mockSave.mockRejectedValue(new Error('network down'));

    render(<WeightIncrementForm initialIncrement={1.25} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });
});
