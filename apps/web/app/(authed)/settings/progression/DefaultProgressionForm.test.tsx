import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserSettingsResponse } from '@lifting-logbook/types';
import DefaultProgressionForm from './DefaultProgressionForm';
import { saveDefaultProgression } from './actions';
import { logClientError } from '@/lib/log-client-error';

jest.mock('./actions', () => ({
  saveDefaultProgression: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({
  logClientError: jest.fn(),
}));

const mockSave = saveDefaultProgression as jest.MockedFunction<typeof saveDefaultProgression>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

const settings = (defaultProgression: UserSettingsResponse['defaultProgression']): UserSettingsResponse => ({
  activeProgram: null,
  workoutSchedule: null,
  defaultWeightIncrement: null,
  unit: null,
  defaultProgression,
});

describe('DefaultProgressionForm (#1210)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers the type as a labelled native select with the catalog default first and no rpe', () => {
    render(<DefaultProgressionForm initialDefault={null} />);
    const select = screen.getByLabelText('Default progression');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('');
    const values = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['', 'linear', 'double', 'amrap_gated', 'percent_wave', 'manual']);
  });

  it('gives the increment and rep range as labelled number fields, disabled until a type is chosen', async () => {
    const user = userEvent.setup();
    render(<DefaultProgressionForm initialDefault={null} />);
    for (const label of ['Increment', 'Rep range bottom', 'Rep range top']) {
      const input = screen.getByRole('spinbutton', { name: label });
      expect(input).toHaveAttribute('type', 'number');
      expect(input).toBeDisabled();
    }
    await user.selectOptions(screen.getByLabelText('Default progression'), 'double');
    expect(screen.getByRole('spinbutton', { name: 'Rep range top' })).toBeEnabled();
  });

  it('preselects a stored default', () => {
    render(
      <DefaultProgressionForm initialDefault={{ type: 'double', increment: 2.5, repsLow: 8, repsHigh: 12 }} />,
    );
    expect(screen.getByLabelText('Default progression')).toHaveValue('double');
    expect(screen.getByRole('spinbutton', { name: 'Increment' })).toHaveValue(2.5);
    expect(screen.getByRole('spinbutton', { name: 'Rep range bottom' })).toHaveValue(8);
    expect(screen.getByRole('spinbutton', { name: 'Rep range top' })).toHaveValue(12);
  });

  it('saves a default with its range', async () => {
    const user = userEvent.setup();
    const saved = { type: 'double' as const, increment: null, repsLow: 8, repsHigh: 12 };
    mockSave.mockResolvedValue(settings(saved));
    render(<DefaultProgressionForm initialDefault={null} />);
    await user.selectOptions(screen.getByLabelText('Default progression'), 'double');
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range bottom' }), '8');
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range top' }), '12');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(saved));
    expect(await screen.findByText(/^Saved at /)).toBeInTheDocument();
  });

  it('clears the default when the catalog option is chosen', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue(settings(null));
    render(<DefaultProgressionForm initialDefault={{ type: 'linear', increment: 5, repsLow: null, repsHigh: 5 }} />);
    await user.selectOptions(screen.getByLabelText('Default progression'), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith(null));
  });

  it('refuses a range whose bottom is above its top, without saving', async () => {
    const user = userEvent.setup();
    render(<DefaultProgressionForm initialDefault={null} />);
    await user.selectOptions(screen.getByLabelText('Default progression'), 'double');
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range bottom' }), '12');
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range top' }), '8');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bottom of the rep range');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('reports a failed save through logClientError', async () => {
    const user = userEvent.setup();
    const err = new Error('network down');
    mockSave.mockRejectedValue(err);
    render(<DefaultProgressionForm initialDefault={null} />);
    await user.selectOptions(screen.getByLabelText('Default progression'), 'manual');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save');
    expect(mockLog).toHaveBeenCalledWith('saveDefaultProgression', err);
  });
});
