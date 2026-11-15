import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResolvedMuscleTargets } from '@lifting-logbook/core';
import type { LiftMetadataResponse, MuscleTargets } from '@lifting-logbook/types';
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
  secondaryMuscleGroups: [],
  substitutions: [],
  foundational: false,
  progression: null,
  progressionIncrement: null,
  repsLow: null,
  repsHigh: null,
  ...overrides,
});

const NONE: ResolvedMuscleTargets = { primary: [], secondary: [], source: 'none' };

const renderEditor = (
  meta = metadata(),
  muscles: ResolvedMuscleTargets = NONE,
  defaultMuscles: MuscleTargets | null = null,
) =>
  render(
    <LiftEditor
      program="5-3-1"
      macrocycleNum={1}
      workoutNum={2}
      initialMetadata={meta}
      muscles={muscles}
      defaultMuscles={defaultMuscles}
    />,
  );

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
        secondaryMuscleGroups: [],
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

describe('LiftEditor muscles (#1017)', () => {
  beforeEach(() => jest.clearAllMocks());

  const BENCH: MuscleTargets = { primary: ['Chest', 'Triceps'], secondary: ['Front Delts'] };
  const bench = (muscles: ResolvedMuscleTargets = { ...BENCH, source: 'default' }) =>
    renderEditor(metadata({ lift: 'Bench Press' }), muscles, BENCH);
  // A picker's chips are its remove buttons, one per muscle.
  const chips = (label: string) => {
    const list = screen.getByLabelText(label).parentElement;
    return list ? within(list).queryAllByRole('button').map((b) => b.getAttribute('aria-label')) : [];
  };
  const saved = () => mockPatch.mock.calls[0][1];

  it('shows the built-in defaults and says where they came from', () => {
    bench();
    expect(chips('Primary Muscles')).toEqual(['Remove Chest', 'Remove Triceps']);
    expect(chips('Secondary Muscles (count ½)')).toEqual(['Remove Front Delts']);
    expect(screen.getByText('Source: Built-in defaults.')).toBeInTheDocument();
  });

  it('shows the lifter’s own muscles, including a legacy tag outside the vocabulary', () => {
    bench({ primary: ['Chest', 'pecs-upper'], secondary: [], source: 'custom' });
    expect(chips('Primary Muscles')).toEqual(['Remove Chest', 'Remove pecs-upper']);
    expect(screen.getByText('Source: Your own.')).toBeInTheDocument();
  });

  it('says a lift with no defaults and no muscles is not counted', () => {
    renderEditor();
    expect(screen.getByText(/Source: None set\./)).toBeInTheDocument();
  });

  it('offers muscles from the vocabulary, leaving out ones the other list holds', async () => {
    const user = userEvent.setup();
    bench();
    await user.type(screen.getByLabelText('Secondary Muscles (count ½)'), 'tri');
    // Triceps is primary, so the secondary search finds nothing to offer.
    expect(screen.queryByRole('option', { name: 'Triceps' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Secondary Muscles (count ½)'));
    await user.type(screen.getByLabelText('Secondary Muscles (count ½)'), 'side');
    await user.click(screen.getByRole('option', { name: 'Side Delts' }));
    expect(chips('Secondary Muscles (count ½)')).toEqual(['Remove Front Delts', 'Remove Side Delts']);
    expect(screen.getByText('Source: Your own.')).toBeInTheDocument();
  });

  it('saves a change as the lifter’s own lists', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    bench();
    await user.click(screen.getByRole('button', { name: 'Remove Triceps' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(saved()).toMatchObject({ muscleGroups: ['Chest'], secondaryMuscleGroups: ['Front Delts'] });
  });

  it('saves lists equal to the defaults as empty, in any order or case', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    bench({ primary: ['triceps', 'Chest'], secondary: ['Front Delts'], source: 'custom' });
    expect(screen.getByText('Source: Built-in defaults.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(saved()).toMatchObject({ muscleGroups: [], secondaryMuscleGroups: [] });
  });

  it('Reset restores the defaults, which then save as empty', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    bench({ primary: ['Quads'], secondary: [], source: 'custom' });
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(chips('Primary Muscles')).toEqual(['Remove Chest', 'Remove Triceps']);
    expect(chips('Secondary Muscles (count ½)')).toEqual(['Remove Front Delts']);
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(saved()).toMatchObject({ muscleGroups: [], secondaryMuscleGroups: [] });
  });

  it('says emptied lists fall back to the defaults', async () => {
    const user = userEvent.setup();
    bench();
    for (const muscle of ['Chest', 'Triceps', 'Front Delts']) {
      await user.click(screen.getByRole('button', { name: `Remove ${muscle}` }));
    }
    expect(screen.getByText(/Source: Built-in defaults, which apply when both lists are empty/)).toBeInTheDocument();
  });

  it('saves a lift with no defaults under its own lists', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue(metadata());
    renderEditor();
    await user.type(screen.getByLabelText('Primary Muscles'), 'bice');
    await user.click(screen.getByRole('option', { name: 'Biceps' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(saved()).toMatchObject({ muscleGroups: ['Biceps'], secondaryMuscleGroups: [] });
  });
});
