import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftModificationResponse, LiftRecordResponse } from '@lifting-logbook/types';
import WorkoutLogger from './WorkoutLogger';
import type { LiftData, WorkingSetData, WorkoutLoggerProps } from './types';
import {
  createLiftModification,
  createLiftRecord,
  fetchLiftModifications,
  recordBodyWeight,
  rescheduleWorkout,
  updateLiftRecord,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { buildDraftKey, buildModificationsDraftKey } from './workoutDraftStorage';
import { ApiClientError } from '@lifting-logbook/api-client';
import { browserNavigation } from '@/lib/macrocycleUrl';

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
  fetchLiftModifications: jest.fn(),
  createLiftModification: jest.fn(),
}));

// Wrapped, not replaced: the #783 tests below check what the real helper writes to the console.
jest.mock('@/lib/log-client-error', () => {
  const actual = jest.requireActual<typeof import('@/lib/log-client-error')>('@/lib/log-client-error');
  return { ...actual, logClientError: jest.fn(actual.logClientError) };
});

// Only the browser navigation is replaced: jsdom can't navigate, and the tests check where the
// real `followMovedMacrocycle` sends the page.
let mockAssign: jest.SpyInstance<void, [string]>;
beforeEach(() => {
  mockAssign = jest.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
});
afterEach(() => {
  mockAssign.mockRestore();
});

const mockCreateLiftRecord = createLiftRecord as jest.MockedFunction<typeof createLiftRecord>;
const mockRecordBodyWeight = recordBodyWeight as jest.MockedFunction<typeof recordBodyWeight>;
const mockUpdateLiftRecord = updateLiftRecord as jest.MockedFunction<typeof updateLiftRecord>;
const mockFetchLiftModifications = fetchLiftModifications as jest.MockedFunction<typeof fetchLiftModifications>;
const mockCreateLiftModification = createLiftModification as jest.MockedFunction<typeof createLiftModification>;
const mockLogClientError = logClientError as jest.MockedFunction<typeof logClientError>;

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
    macrocycleNum: 1,
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
  macrocycleNum: 1,
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
  // No modifications unless a test says otherwise.
  mockFetchLiftModifications.mockResolvedValue([]);
  // Several tests below share the default program/macrocycle/workout/lift/set identity
  // from makeProps()/makeLift() and would otherwise leak drafts across tests.
  window.localStorage.clear();
  // The missing-id reload records its page here, which would stop a later test's reload.
  window.sessionStorage.clear();
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
      undefined,
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
  // Matches makeProps()/makeLift()'s defaults: program '5-3-1', macrocycleNum 1, workoutNum 1,
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

describe('WorkoutLogger — a lift planned twice in a day (#1027)', () => {
  const first = makeLift();
  const second = makeLift({ occurrence: 1, workingSets: [{ setNum: 1, totalLoad: 60, reps: 12, amrap: false }] });

  it('logging a set on one occurrence leaves the other unlogged', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps({ lifts: [first, second] })} />);

    await user.click(screen.getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Switch to overview' }));

    expect(screen.getAllByText(/\d\/1 sets/).map((el) => el.textContent)).toEqual(['1/1 sets', '0/1 sets']);
  });

  it('logs a set on the second occurrence against that occurrence', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, occurrence: 1, weight: 60, reps: 12 });
    render(<WorkoutLogger {...makeProps({ lifts: [first, second] })} />);

    const [, secondDot] = screen.getAllByRole('button', { name: 'Go to Back Squat' });
    if (!secondDot) throw new Error('expected a navigation dot for each Back Squat occurrence');
    await user.click(secondDot);
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() =>
      expect(mockCreateLiftRecord).toHaveBeenCalledWith(
        '5-3-1',
        expect.objectContaining({ lift: 'Back Squat', occurrence: 1, setNum: 1, weight: 60, reps: 12 }),
        undefined,
      ),
    );
  });

  it('keeps each occurrence’s in-progress draft apart', async () => {
    const user = userEvent.setup();
    render(<WorkoutLogger {...makeProps({ lifts: [first, second] })} />);

    const [, secondDot] = screen.getAllByRole('button', { name: 'Go to Back Squat' });
    if (!secondDot) throw new Error('expected a navigation dot for each Back Squat occurrence');
    await user.click(secondDot);
    await user.clear(screen.getByLabelText('Reps'));
    await user.type(screen.getByLabelText('Reps'), '10');

    expect(window.localStorage.getItem(buildDraftKey('5-3-1', 1, 1, 'Back Squat', 1, 1))).toContain('"reps":"10"');
    expect(window.localStorage.getItem(buildDraftKey('5-3-1', 1, 1, 'Back Squat', 1))).toBeNull();
    // A first occurrence keeps the key a draft had before occurrences existed.
    expect(buildDraftKey('5-3-1', 1, 1, 'Back Squat', 1, 0)).toBe(buildDraftKey('5-3-1', 1, 1, 'Back Squat', 1));
  });
});

describe('WorkoutLogger — focus lifts (#1060)', () => {
  const raise = makeLift({
    lift: 'Lateral Raise',
    workingSets: [{ setNum: 1, totalLoad: 25, reps: 12, amrap: false }],
    focus: { area: 'Shoulders', summary: '1 × 10–12' },
  });

  it('marks a focus lift with its area and prescription', async () => {
    const user = userEvent.setup();
    render(<WorkoutLogger {...makeProps({ lifts: [makeLift(), raise] })} />);

    expect(screen.queryByText(/Focus work/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Lateral Raise' }));
    expect(screen.getByText('Focus work · Shoulders · 1 × 10–12')).toBeInTheDocument();
  });

  it('logs a focus set as an ordinary lift record against the workout', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, lift: 'Lateral Raise', weight: 25, reps: 12 });
    render(<WorkoutLogger {...makeProps({ lifts: [raise] })} />);

    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() =>
      expect(mockCreateLiftRecord).toHaveBeenCalledWith('5-3-1', {
        program: '5-3-1',
        macrocycleNum: 1,
        workoutNum: 1,
        date: '2026-07-08',
        lift: 'Lateral Raise',
        setNum: 1,
        weight: 25,
        reps: 12,
        notes: undefined,
      }, undefined),
    );
  });

  it('lets the workout finish with its focus sets unlogged', () => {
    const squat = makeLift({
      workingSets: [{ setNum: 1, totalLoad: 225, reps: 5, amrap: false, existing: { id: 'rec-1', weight: 225, reps: 5, notes: '' } }],
    });
    render(<WorkoutLogger {...makeProps({ lifts: [squat, raise] })} />);

    expect(screen.getByRole('button', { name: 'Finish workout' })).toBeInTheDocument();
  });
});

describe('WorkoutLogger — a renumbered macrocycle (#1198)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the macrocycle id with the write', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps({ macrocycleId: 'mc-a' })} />);

    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalled());
    expect(mockCreateLiftRecord.mock.calls[0]?.[2]).toBe('mc-a');
  });

  it('reloads at the new number when the API says the macrocycle moved, and keeps the draft', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockRejectedValue(
      new ApiClientError('moved', 409, 'macrocycle-moved', { code: 'macrocycle-moved', macrocycleNum: 2 }),
    );
    window.history.pushState({}, '', '/macrocycle/1/workout/1?from=history');
    render(<WorkoutLogger {...makeProps({ macrocycleId: 'mc-a' })} />);

    await user.clear(screen.getByLabelText('Weight in lbs'));
    await user.type(screen.getByLabelText('Weight in lbs'), '225');
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockAssign).toHaveBeenCalledWith('/macrocycle/2/workout/1?from=history'));
    window.history.pushState({}, '', '/');
    expect(screen.queryByText('Failed to log set. Try again.')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(buildDraftKey('5-3-1', 1, 1, 'Back Squat', 1, undefined, 'mc-a'))).not.toBeNull();
  });

  it('reloads the page when the API asks for the macrocycle id, without an error (#1200)', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockRejectedValue(
      new ApiClientError('Reload the page and try again.', 400, 'macrocycle-id-required', { code: 'macrocycle-id-required' }),
    );
    window.history.pushState({}, '', '/macrocycle/1/workout/1?from=history');
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockAssign).toHaveBeenCalledWith('/macrocycle/1/workout/1?from=history'));
    window.history.pushState({}, '', '/');
    expect(screen.queryByText('Failed to log set. Try again.')).not.toBeInTheDocument();
  });

  it('puts a logged workout’s date back and says why when the change is refused, after its one reload (#1200)', async () => {
    const reload = new ApiClientError("This page of '5-3-1' doesn't say which macrocycle it's for. Reload the page and try again.", 400, 'macrocycle-id-required');
    jest.mocked(rescheduleWorkout).mockRejectedValue(reload);
    window.history.pushState({}, '', '/macrocycle/1/workout/1');
    // The page was already reloaded for a missing id a moment ago.
    window.sessionStorage.setItem('macrocycle-id-reload', JSON.stringify({ page: '/macrocycle/1/workout/1', at: Date.now() }));
    try {
      render(<WorkoutLogger {...makeProps({ isReadOnly: true })} />);

      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-07-10' } });

      await waitFor(() => expect(screen.getByText(/doesn't say which macrocycle it's for/)).toBeInTheDocument());
      expect(screen.getByLabelText('Date')).toHaveValue('2026-07-08');
      expect(mockAssign).not.toHaveBeenCalled();
    } finally {
      window.sessionStorage.clear();
      window.history.pushState({}, '', '/');
    }
  });

  it('asks for a retry while an import holds the lock, without reloading', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockRejectedValue(new ApiClientError('An import is changing your macrocycles. Try again in a moment.', 409, 'import-in-progress'));
    render(<WorkoutLogger {...makeProps({ macrocycleId: 'mc-a' })} />);

    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(screen.getByText(/An import is changing your macrocycles/)).toBeInTheDocument());
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('asks for a reload, not a retry, when the macrocycle the page shows no longer exists', async () => {
    const user = userEvent.setup();
    const msg = "This page's macrocycle of '5-3-1' no longer exists. Reload the page to see the current one.";
    mockCreateLiftRecord.mockRejectedValue(new ApiClientError(msg, 404, 'macrocycle-not-found'));
    render(<WorkoutLogger {...makeProps({ macrocycleId: 'mc-a' })} />);

    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(screen.getByText(msg)).toBeInTheDocument());
    expect(screen.queryByText('Failed to log set. Try again.')).not.toBeInTheDocument();
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('reports a duplicate-set 409 as before, without reloading', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockRejectedValue(new ApiClientError('duplicate', 409));
    render(<WorkoutLogger {...makeProps({ macrocycleId: 'mc-a' })} />);

    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(screen.getByText('Failed to log set. Try again.')).toBeInTheDocument());
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

describe('WorkoutLogger — lift modifications (#1152)', () => {
  const modification = (
    id: string,
    name: string,
    extra: Partial<LiftModificationResponse> = {},
  ): LiftModificationResponse => ({
    id,
    lift: 'back-squat',
    name,
    description: '',
    maxMode: 'none',
    createdAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  });
  const PAUSED = modification('m-paused', 'Paused', { description: 'Two seconds at the bottom' });
  const PAUSED_REF = [{ id: 'm-paused', name: 'Paused' }];
  const twoSets = (set1?: WorkingSetData['existing']) =>
    makeLift({
      workingSets: [
        { setNum: 1, totalLoad: 225, reps: 5, amrap: false, ...(set1 && { existing: set1 }) },
        { setNum: 2, totalLoad: 225, reps: 5, amrap: false },
      ],
    });
  const createdBody = (call: number) => mockCreateLiftRecord.mock.calls[call]?.[1];

  it("records each set's own modifications", async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockResolvedValue([PAUSED]);
    mockCreateLiftRecord
      .mockResolvedValueOnce(LOGGED)
      .mockResolvedValueOnce({ ...LOGGED, id: 'rec-2', setNum: 2, modifications: PAUSED_REF });
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets()] })} />);

    const toggle = await screen.findByRole('button', { name: 'Paused', pressed: false });
    expect(mockFetchLiftModifications).toHaveBeenCalledWith('Back Squat');
    const [logSet1] = screen.getAllByRole('button', { name: 'Log' });
    if (!logSet1) throw new Error('expected a Log button for set 1');
    await user.click(logSet1);
    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Paused', pressed: true })).toBeInTheDocument();
    expect(screen.getByText('Two seconds at the bottom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));
    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(2));

    expect(createdBody(0)).not.toHaveProperty('modifications');
    expect(createdBody(1)).toEqual(expect.objectContaining({ setNum: 2, modifications: ['m-paused'] }));
    // Set 1 keeps what it recorded; set 2 names its modification.
    expect(screen.getByText('225 lbs × 5')).toBeInTheDocument();
    expect(screen.getByText('225 lbs × 5 · Paused')).toBeInTheDocument();
  });

  it('shows no toggles and sends no modifications for a lift without any', async () => {
    const user = userEvent.setup();
    mockCreateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps()} />);

    expect(await screen.findByRole('button', { name: 'Add modification' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { pressed: false })).toEqual([]);
    expect(screen.queryAllByRole('button', { pressed: true })).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
    expect(createdBody(0)).not.toHaveProperty('modifications');
  });

  it('hides the toggles and still logs a set when the fetch fails', async () => {
    const user = userEvent.setup();
    const failure = new Error('API 503 Service Unavailable for /lifts/modifications');
    mockFetchLiftModifications.mockRejectedValue(failure);
    mockCreateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps()} />);

    await waitFor(() =>
      expect(mockLogClientError).toHaveBeenCalledWith('fetchLiftModifications', failure, {
        program: '5-3-1',
        lift: 'Back Squat',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Add modification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Back Squat modifications' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
    expect(createdBody(0)).not.toHaveProperty('modifications');
    expect(screen.getByText('225 lbs × 5')).toBeInTheDocument();
  });

  it("starts from the occurrence's last logged set", async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockResolvedValue([PAUSED]);
    mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, id: 'rec-2', setNum: 2 });
    // A toggle saved before the set was logged loses to the logged set.
    window.localStorage.setItem(buildModificationsDraftKey('5-3-1', 1, 1, 'Back Squat'), '[]');
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets({ ...LOGGED, modifications: PAUSED_REF })] })} />);

    expect(screen.getByText('225 lbs × 5 · Paused')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Paused', pressed: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() =>
      expect(createdBody(0)).toEqual(expect.objectContaining({ setNum: 2, modifications: ['m-paused'] })),
    );
  });

  it('keeps a toggle changed before the first set across a reload, until the workout is finished', async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockResolvedValue([PAUSED]);
    const { unmount } = render(<WorkoutLogger {...makeProps()} />);
    await user.click(await screen.findByRole('button', { name: 'Paused', pressed: false }));
    unmount();

    mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, modifications: PAUSED_REF });
    render(<WorkoutLogger {...makeProps()} />);
    expect(await screen.findByRole('button', { name: 'Paused', pressed: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));
    await user.click(await screen.findByRole('button', { name: 'Finish workout' }));

    expect(createdBody(0)).toEqual(expect.objectContaining({ modifications: ['m-paused'] }));
    expect(window.localStorage.getItem(buildModificationsDraftKey('5-3-1', 1, 1, 'Back Squat'))).toBeNull();
  });

  it('refreshes the toggles and keeps the typed set when a modification was removed elsewhere', async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockResolvedValueOnce([PAUSED]).mockResolvedValueOnce([]);
    mockCreateLiftRecord.mockRejectedValue(
      new ApiClientError("'m-paused' is not one of your modifications of Back Squat", 400),
    );
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(await screen.findByRole('button', { name: 'Paused', pressed: false }));
    await user.clear(screen.getByLabelText('Weight in lbs'));
    await user.type(screen.getByLabelText('Weight in lbs'), '230');
    await user.click(screen.getByRole('button', { name: 'Log' }));

    expect(await screen.findByText(/A modification on this set was removed/)).toBeInTheDocument();
    expect(mockFetchLiftModifications).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Paused' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Weight in lbs')).toHaveValue(230);
  });

  it('adds a modification inline and turns it on', async () => {
    const user = userEvent.setup();
    mockCreateLiftModification.mockResolvedValue({ ok: true, data: PAUSED });
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(await screen.findByRole('button', { name: 'Add modification' }));
    await user.type(screen.getByLabelText('Modification name'), 'Paused');
    await user.click(screen.getByRole('button', { name: 'Save modification' }));

    expect(mockCreateLiftModification).toHaveBeenCalledWith({ lift: 'Back Squat', name: 'Paused' });
    expect(await screen.findByRole('button', { name: 'Paused', pressed: true })).toBeInTheDocument();
  });

  it("shows the server's reason when the name is taken", async () => {
    const user = userEvent.setup();
    mockCreateLiftModification.mockResolvedValue({ ok: false, conflictMessage: "Back Squat already has 'Paused'" });
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(await screen.findByRole('button', { name: 'Add modification' }));
    await user.type(screen.getByLabelText('Modification name'), 'Paused');
    await user.click(screen.getByRole('button', { name: 'Save modification' }));

    expect(await screen.findByText("Back Squat already has 'Paused'")).toBeInTheDocument();
  });

  it("edits a logged set's modifications", async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockResolvedValue([PAUSED]);
    mockUpdateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets({ ...LOGGED, modifications: PAUSED_REF })] })} />);

    await screen.findByRole('button', { name: 'Paused', pressed: true });
    await user.click(screen.getByRole('button', { name: 'Edit set 1' }));
    const editToggles = within(screen.getByRole('group', { name: 'Set 1 modifications' }));
    await user.click(editToggles.getByRole('button', { name: 'Paused', pressed: true }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockUpdateLiftRecord).toHaveBeenCalledWith(
        '5-3-1',
        'rec-1',
        expect.objectContaining({ modifications: [] }),
        undefined,
      ),
    );
    expect(screen.getByText('225 lbs × 5')).toBeInTheDocument();
  });

  it('sends no modifications on an edit that leaves them alone', async () => {
    const user = userEvent.setup();
    mockUpdateLiftRecord.mockResolvedValue(LOGGED);
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets(LOGGED)] })} />);

    await screen.findByRole('button', { name: 'Add modification' });
    await user.click(screen.getByRole('button', { name: 'Edit set 1' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdateLiftRecord).toHaveBeenCalledTimes(1));
    expect(mockUpdateLiftRecord.mock.calls[0]?.[2]).not.toHaveProperty('modifications');
  });

  it('turns off another modification with its own max', async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockResolvedValue([
      modification('m-wide', 'Wide grip', { maxMode: 'own' }),
      modification('m-close', 'Close grip', { maxMode: 'own' }),
      PAUSED,
    ]);
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(await screen.findByRole('button', { name: 'Paused', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'Wide grip', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'Close grip', pressed: false }));

    expect(screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual([
      'Close grip',
      'Paused',
    ]);
  });

  it('shows no toggles on a read-only workout', () => {
    render(
      <WorkoutLogger
        {...makeProps({
          isReadOnly: true,
          lifts: [
            makeLift({
              workingSets: [
                { setNum: 1, totalLoad: 225, reps: 5, amrap: false, existing: { ...LOGGED, modifications: PAUSED_REF } },
              ],
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText('225 lbs × 5 · Paused')).toBeInTheDocument();
    expect(mockFetchLiftModifications).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Add modification' })).not.toBeInTheDocument();
  });
});
