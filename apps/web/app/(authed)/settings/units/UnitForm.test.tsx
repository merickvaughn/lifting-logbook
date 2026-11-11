import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UnitForm from './UnitForm';
import { saveUnit } from './actions';

jest.mock('./actions', () => ({
  saveUnit: jest.fn(),
}));

const mockSave = saveUnit as jest.MockedFunction<typeof saveUnit>;

describe('UnitForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults the select to lbs when no unit is set yet', () => {
    render(<UnitForm initialUnit={null} />);
    expect(screen.getByLabelText('Weight unit')).toHaveValue('lbs');
  });

  it('preselects the stored unit', () => {
    render(<UnitForm initialUnit="kg" />);
    expect(screen.getByLabelText('Weight unit')).toHaveValue('kg');
  });

  it('lists exactly the two allowed units', () => {
    render(<UnitForm initialUnit={null} />);
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['lbs', 'kg']);
  });

  it('saves the selected unit and shows a confirmation', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue({
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: null,
      unit: 'kg',
      defaultProgression: null,
    });

    render(<UnitForm initialUnit="lbs" />);
    await user.selectOptions(screen.getByLabelText('Weight unit'), 'kg');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith('kg'));
    expect(await screen.findByText(/^Saved at /)).toBeInTheDocument();
  });

  it('shows an error message when the save fails', async () => {
    const user = userEvent.setup();
    mockSave.mockRejectedValue(new Error('network down'));

    render(<UnitForm initialUnit="lbs" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });
});
