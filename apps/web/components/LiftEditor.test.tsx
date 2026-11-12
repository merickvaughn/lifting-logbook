import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftMetadataResponse } from '@lifting-logbook/types';
import LiftEditor from './LiftEditor';
import { patchLiftMetadata } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: jest.fn() }),
}));
jest.mock('@/lib/client-api', () => ({
  patchLiftMetadata: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({
  logClientError: jest.fn(),
}));
// The tag pickers aren't under test here.
jest.mock('./CatalogTagPicker', () => ({ __esModule: true, default: () => null }));
jest.mock('./FreeTagPicker', () => ({ __esModule: true, default: () => null }));
// Tested on its own; here it only has to receive the program and lift (#1153).
jest.mock('./LiftModificationsEditor', () => ({
  __esModule: true,
  default: ({ program, lift }: { program: string; lift: string }) => (
    <p>
      modifications:{program}:{lift}
    </p>
  ),
}));

const mockPatch = patchLiftMetadata as jest.MockedFunction<typeof patchLiftMetadata>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

const metadata = (overrides: Partial<LiftMetadataResponse> = {}): LiftMetadataResponse => ({
  lift: 'Cable Curl',
  muscleGroups: [],
  substitutions: [],
  foundational: false,
  progression: null,
  progressionIncrement: null,
  repsLow: null,
  repsHigh: null,
  ...overrides,
});

const renderEditor = (meta = metadata()) =>
  render(<LiftEditor program="5-3-1" macrocycleNum={1} workoutNum={2} initialMetadata={meta} />);

describe("LiftEditor — the lift's modifications (#1153)", () => {
  it('edits them for the program and lift', () => {
    renderEditor();
    expect(screen.getByText('modifications:5-3-1:Cable Curl')).toBeInTheDocument();
  });
});

describe('LiftEditor progression (#1210)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers the type as a labelled native select, without rpe', () => {
    renderEditor();
    const select = screen.getByLabelText('Progression');
    expect(select.tagName).toBe('SELECT');
    const values = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['', 'linear', 'double', 'amrap_gated', 'percent_wave', 'manual']);
  });

  it('shows the stored values in labelled number fields', () => {
    renderEditor(metadata({ progression: 'double', progressionIncrement: 2.5, repsLow: 8, repsHigh: 12 }));
    expect(screen.getByLabelText('Progression')).toHaveValue('double');
    expect(screen.getByRole('spinbutton', { name: 'Increment' })).toHaveValue(2.5);
    expect(screen.getByRole('spinbutton', { name: 'Rep range bottom' })).toHaveValue(8);
    expect(screen.getByRole('spinbutton', { name: 'Rep range top' })).toHaveValue(12);
  });

  it('saves the lift progression with the rest of its metadata', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    renderEditor();
    await user.selectOptions(screen.getByLabelText('Progression'), 'double');
    await user.type(screen.getByRole('spinbutton', { name: 'Increment' }), '2.5');
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range bottom' }), '8');
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range top' }), '12');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('Cable Curl', {
        muscleGroups: [],
        substitutions: [],
        foundational: false,
        progression: 'double',
        progressionIncrement: 2.5,
        repsLow: 8,
        repsHigh: 12,
      }),
    );
  });

  it('clears the type and range when the default option is chosen, and keeps the increment', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    renderEditor(metadata({ progression: 'linear', progressionIncrement: 5, repsLow: 5, repsHigh: 5 }));
    await user.selectOptions(screen.getByLabelText('Progression'), '');
    expect(screen.getByRole('spinbutton', { name: 'Rep range top' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        'Cable Curl',
        expect.objectContaining({ progression: null, progressionIncrement: 5, repsLow: null, repsHigh: null }),
      ),
    );
  });

  // A lift's own increment applies whatever type it follows (ADR-043), so it needs no type.
  it('saves an increment for a lift that follows the default progression', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    renderEditor();
    const increment = screen.getByRole('spinbutton', { name: 'Increment' });
    expect(increment).toBeEnabled();
    await user.type(increment, '2.5');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        'Cable Curl',
        expect.objectContaining({ progression: null, progressionIncrement: 2.5 }),
      ),
    );
  });

  it('refuses a range whose bottom is above its top, without saving', async () => {
    const user = userEvent.setup();
    renderEditor(metadata({ progression: 'double' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range bottom' }), '12');
    await user.type(screen.getByRole('spinbutton', { name: 'Rep range top' }), '8');
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('bottom of the rep range');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  // jsdom's number inputs never report badInput, so the browser's half is stubbed: the input
  // reads '' and says its text can't be parsed, firing only `input` (React skips onChange).
  const report = (input: HTMLElement, badInput: boolean) => {
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput } });
    fireEvent.input(input);
  };

  it('refuses unparseable text in a number field rather than clearing the stored value', async () => {
    const user = userEvent.setup();
    renderEditor(metadata({ progression: 'double', repsLow: 8, repsHigh: 12 }));
    const top = screen.getByRole('spinbutton', { name: 'Rep range top' });
    await user.clear(top);
    report(top, true);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('whole numbers');
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('saves once unparseable text is cleared from the field', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    renderEditor(metadata({ progression: 'double', repsLow: 8, repsHigh: 12 }));
    const top = screen.getByRole('spinbutton', { name: 'Rep range top' });
    await user.clear(top);
    report(top, true);
    report(top, false);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('Cable Curl', expect.objectContaining({ repsLow: 8, repsHigh: null })),
    );
  });

  it('reports a failed save through logClientError', async () => {
    const user = userEvent.setup();
    const err = new Error('400');
    mockPatch.mockRejectedValue(err);
    renderEditor();
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save');
    expect(mockLog).toHaveBeenCalledWith('patchLiftMetadata', err, { lift: 'Cable Curl' });
  });
});
