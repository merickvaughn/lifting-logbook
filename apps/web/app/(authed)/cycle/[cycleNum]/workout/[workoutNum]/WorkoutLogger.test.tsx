import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftRecordResponse } from '@lifting-logbook/types';
import WorkoutLogger from './WorkoutLogger';
import type { LiftData, WorkoutLoggerProps } from './types';
import { createLiftRecord, recordBodyWeight } from '@/lib/client-api';
import { buildDraftKey } from './workoutDraftStorage';

// jest.mock is hoisted above the imports, so `createLiftRecord`/`recordBodyWeight`
// resolve to the jest.fn() mocks below.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/client-api', () => ({
  createLiftRecord: jest.fn(),
  updateLiftRecord: jest.fn(),
  recordBodyWeight: jest.fn(),
  rescheduleWorkout: jest.fn(),
}));

const mockCreateLiftRecord = createLiftRecord as jest.MockedFunction<typeof createLiftRecord>;
const mockRecordBodyWeight = recordBodyWeight as jest.MockedFunction<typeof recordBodyWeight>;

function makeLift(overrides: Partial<LiftData> = {}): LiftData {
  return {
    lift: 'Back Squat',
    isBodyweightComponent: false,
    warmUpSets: [],
    workingSets: [{ setNum: 1, totalLoad: 100, reps: 5, amrap: false }],
    ...overrides,
  };
}

function makeProps(overrides: Partial<WorkoutLoggerProps> = {}): WorkoutLoggerProps {
  return {
    program: '5-3-1',
    cycleNum: 1,
    workoutNum: 1,
    date: '2026-07-08',
    lifts: [makeLift()],
    hasBodyweightComponent: false,
    isReadOnly: false,
    initialBodyWeight: null,
    unit: 'lbs',
    ...overrides,
  };
}

const LOGGED: LiftRecordResponse = {
  id: 'rec-1',
  program: '5-3-1',
  cycleNum: 1,
  workoutNum: 1,
  date: '2026-07-08',
  lift: 'Back Squat',
  setNum: 1,
  weight: 225,
  reps: 5,
  notes: '',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Several tests below share the default program/cycle/workout/lift/set identity
  // from makeProps()/makeLift() and would otherwise leak drafts across tests.
  window.localStorage.clear();
});

describe('WorkoutLogger — weight-unit display preference', () => {
  it('renders planned warm-up and working-set weights converted to the preferred unit', () => {
    render(
      <WorkoutLogger
        {...makeProps({
          unit: 'kg',
          isReadOnly: true,
          lifts: [
            makeLift({
              warmUpSets: [{ reps: 5, totalLoad: 95 }],
              workingSets: [{ setNum: 1, totalLoad: 100, reps: 5, amrap: false }],
            }),
          ],
        })}
      />,
    );

    // 95 lbs -> 43.09 kg (warm-up), 100 lbs -> 45.36 kg (working set).
    expect(screen.getByText(/43\.09 kg/)).toBeInTheDocument();
    expect(screen.getByText(/45\.36 kg/)).toBeInTheDocument();
  });

  it('renders a logged set summary in the preferred unit', () => {
    render(
      <WorkoutLogger
        {...makeProps({
          unit: 'kg',
          lifts: [
            makeLift({
              workingSets: [
                { setNum: 1, totalLoad: 100, reps: 5, amrap: false, existing: LOGGED },
              ],
            }),
          ],
        })}
      />,
    );

    // LOGGED.weight is 225 lbs -> 102.06 kg.
    expect(screen.getByText(/102\.06 kg/)).toBeInTheDocument();
  });

  it('leaves lbs display byte-identical and shows no conversion hint for lbs users', () => {
    const { container } = render(
      <WorkoutLogger
        {...makeProps({
          unit: 'lbs',
          lifts: [makeLift({ warmUpSets: [{ reps: 5, totalLoad: 95 }] })],
        })}
      />,
    );

    expect(screen.getByText(/95 lbs/)).toBeInTheDocument();
    // No approximate-conversion hint is rendered when the display unit is lbs.
    expect(container.textContent).not.toContain('≈');
  });

  it('logs the weight in lbs, unchanged by the kg display preference', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps({ unit: 'kg' })} />);

    const weightInput = screen.getByLabelText('Weight in lbs');
    await user.clear(weightInput);
    await user.type(weightInput, '225');

    // A read-only kg hint is shown, but the editable value itself stays in lbs.
    expect(screen.getByText(/≈ 102\.06 kg/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
    // The submitted weight is the lbs number the user typed — never the kg display value.
    expect(mockCreateLiftRecord).toHaveBeenCalledWith(
      '5-3-1',
      expect.objectContaining({ weight: 225, reps: 5, setNum: 1, lift: 'Back Squat' }),
    );
  });

  it('saves body weight in the preferred unit', async () => {
    const user = userEvent.setup();
    mockRecordBodyWeight.mockResolvedValue(undefined);
    render(
      <WorkoutLogger
        {...makeProps({
          unit: 'kg',
          hasBodyweightComponent: true,
          initialBodyWeight: null,
          lifts: [
            makeLift({
              lift: 'Chin-up',
              isBodyweightComponent: true,
              workingSets: [{ setNum: 1, totalLoad: 100, reps: 5, amrap: false }],
            }),
          ],
        })}
      />,
    );

    const bwInput = screen.getByLabelText('Body weight (kg)');
    await user.type(bwInput, '80');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(mockRecordBodyWeight).toHaveBeenCalledTimes(1));
    // Persisted in the entered (preferred) unit — body-weight records store a per-record unit.
    expect(mockRecordBodyWeight).toHaveBeenCalledWith(
      '5-3-1',
      { date: '2026-07-08', weight: 80, unit: 'kg' },
    );
  });

  it('rounds the bodyweight-component added-weight default (no float-precision artifact)', () => {
    render(
      <WorkoutLogger
        {...makeProps({
          // Body weight already recorded in lbs (page.tsx normalizes from the stored unit,
          // so this value is a kg-derived conversion carrying float noise); gate is skipped.
          initialBodyWeight: 176.3699237,
          hasBodyweightComponent: true,
          lifts: [
            makeLift({
              lift: 'Chin-up',
              isBodyweightComponent: true,
              workingSets: [{ setNum: 1, totalLoad: 200, reps: 5, amrap: false }],
            }),
          ],
        })}
      />,
    );

    // 200 - 176.3699237 = 23.6300763… -> rounded to 23.63, never a raw float like 23.630076300000013.
    expect(screen.getByLabelText('Weight in lbs')).toHaveValue(23.63);
  });
});

describe('WorkoutLogger — mutation failure logging (#783)', () => {
  it('captures the underlying error and still shows the message when logging a set fails', async () => {
    const user = userEvent.setup();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('API 500 Internal Server Error for /lift-records');
    mockCreateLiftRecord.mockRejectedValue(failure);

    render(<WorkoutLogger {...makeProps()} />);

    // Default weight (100) and reps (5) are valid, so the click reaches createLiftRecord.
    await user.click(screen.getByRole('button', { name: 'Log' }));

    // Generic user-facing message is preserved — no UX regression.
    await waitFor(() =>
      expect(screen.getByText('Failed to log set. Try again.')).toBeInTheDocument(),
    );
    // ...and the real error is captured rather than swallowed by the old `catch {}`.
    expect(errorSpy).toHaveBeenCalledWith(
      '[client-mutation] createLiftRecord failed',
      failure,
      expect.objectContaining({ program: '5-3-1', lift: 'Back Squat', setNum: 1 }),
    );
    errorSpy.mockRestore();
  });
});

describe('WorkoutLogger — in-progress set draft persistence (#878)', () => {
  // Matches makeProps()/makeLift()'s defaults: program '5-3-1', cycleNum 1, workoutNum 1,
  // lift 'Back Squat', setNum 1.
  const DRAFT_KEY = buildDraftKey('5-3-1', 1, 1, 'Back Squat', 1);

  it('persists an in-progress (unsubmitted) set to localStorage as the user types', async () => {
    const user = userEvent.setup();
    render(<WorkoutLogger {...makeProps()} />);

    await user.clear(screen.getByLabelText('Weight in lbs'));
    await user.type(screen.getByLabelText('Weight in lbs'), '225');

    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (raw === null) throw new Error('expected a draft to be persisted');
    expect(JSON.parse(raw)).toEqual({ weight: '225', reps: '5', notes: '' });
  });

  it('restores an in-progress set after a full remount (simulating a reload)', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const { unmount } = render(<WorkoutLogger {...props} />);

    await user.clear(screen.getByLabelText('Weight in lbs'));
    await user.type(screen.getByLabelText('Weight in lbs'), '225');
    await user.type(screen.getByPlaceholderText('Notes (optional)'), 'felt heavy');
    unmount();

    render(<WorkoutLogger {...props} />);
    expect(screen.getByLabelText('Weight in lbs')).toHaveValue(225);
    expect(screen.getByPlaceholderText('Notes (optional)')).toHaveValue('felt heavy');
  });

  it('clears the persisted draft after a successful log submission', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps()} />);

    await user.clear(screen.getByLabelText('Weight in lbs'));
    await user.type(screen.getByLabelText('Weight in lbs'), '225');
    expect(window.localStorage.getItem(DRAFT_KEY)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));

    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('ignores a stale leftover draft when editing an already-logged set', async () => {
    const user = userEvent.setup();
    // Simulate a draft typed before this set was logged elsewhere (e.g. a different
    // tab) — it must never leak into the edit form, which should reflect the real
    // logged record instead.
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ weight: '999', reps: '99', notes: 'stale' }),
    );

    render(
      <WorkoutLogger
        {...makeProps({
          lifts: [
            makeLift({
              workingSets: [{ setNum: 1, totalLoad: 100, reps: 5, amrap: false, existing: LOGGED }],
            }),
          ],
        })}
      />,
    );

    // Read-only summary reflects the real logged record, never the stale draft.
    expect(screen.getByText(/225 lbs/)).toBeInTheDocument();
    expect(screen.queryByText(/999/)).not.toBeInTheDocument();

    // Entering edit mode also must not pick up the stray draft.
    await user.click(screen.getByRole('button', { name: 'Edit set 1' }));
    expect(screen.getByLabelText('Weight in lbs')).toHaveValue(225);
    expect(screen.getByLabelText('Reps')).toHaveValue(5);
    expect(screen.getByPlaceholderText('Notes (optional)')).toHaveValue('');
  });
});
