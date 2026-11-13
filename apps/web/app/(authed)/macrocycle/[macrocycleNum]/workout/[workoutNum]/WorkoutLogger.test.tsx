import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import type { LiftingProgramSpecResponse, LiftModificationResponse, LiftRecordResponse } from '@lifting-logbook/types';
import WorkoutLogger from './WorkoutLogger';
import type { LiftData, WorkingSetData, WorkoutLoggerProps } from './types';
import {
  createLiftModification,
  createLiftRecord,
  fetchLiftModifications,
  fetchLiftModificationsByLift,
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
  fetchLiftModificationsByLift: jest.fn(),
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
const mockFetchLiftModificationsByLift = jest.mocked(fetchLiftModificationsByLift);
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
    ownMaxes: {},
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
  // The page load reads every lift in one request (#1242). By default it answers each lift with
  // what the single-lift read would, so a test sets a lift's list once for the load and the
  // refresh alike; one failed lift fails the whole request, as one failed response would.
  mockFetchLiftModificationsByLift.mockImplementation(async (lifts) =>
    Object.fromEntries(await Promise.all(lifts.map(async (lift) => [lift, await mockFetchLiftModifications(lift)]))),
  );
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
    // The weight was typed, which the draft records so a re-plan leaves it (#1153).
    expect(JSON.parse(raw)).toEqual({ weight: '225', reps: '5', notes: '', weightTyped: true });
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
    expect(mockFetchLiftModificationsByLift).toHaveBeenCalledWith(['Back Squat']);
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

  it("reads every lift's modifications in one request, and shows each lift its own (#1242)", async () => {
    const user = userEvent.setup();
    const WIDE = modification('m-wide', 'Wide grip', { lift: 'bench-press' });
    mockFetchLiftModificationsByLift.mockResolvedValue({ 'Back Squat': [PAUSED], 'Bench Press': [WIDE], Deadlift: [] });
    const lifts = [makeLift(), makeLift({ lift: 'Bench Press' }), makeLift({ lift: 'Deadlift' }), makeLift({ occurrence: 1 })];
    render(<WorkoutLogger {...makeProps({ lifts })} />);

    expect(await screen.findByRole('group', { name: 'Back Squat modifications' })).toHaveTextContent('Paused');
    expect(mockFetchLiftModificationsByLift).toHaveBeenCalledTimes(1);
    expect(mockFetchLiftModificationsByLift).toHaveBeenCalledWith(['Back Squat', 'Bench Press', 'Deadlift']);
    expect(mockFetchLiftModifications).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Go to Bench Press' }));
    const bench = screen.getByRole('group', { name: 'Bench Press modifications' });
    expect(within(bench).getByRole('button', { name: 'Wide grip', pressed: false })).toBeInTheDocument();
    expect(within(bench).queryByRole('button', { name: 'Paused' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go to Deadlift' }));
    expect(screen.getByRole('button', { name: 'Add modification' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { pressed: false })).toEqual([]);
    expect(mockFetchLiftModificationsByLift).toHaveBeenCalledTimes(1);
  });

  it('treats a lift the response leaves out as a failed read, not a lift with none (#1242)', async () => {
    mockFetchLiftModificationsByLift.mockResolvedValue({});
    render(<WorkoutLogger {...makeProps()} />);

    expect(await screen.findByText("Modifications didn't load, so sets log without them.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add modification' })).not.toBeInTheDocument();
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
      expect(mockLogClientError).toHaveBeenCalledWith('fetchLiftModificationsByLift', failure, {
        program: '5-3-1',
        lifts: 'Back Squat',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Add modification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Back Squat modifications' })).not.toBeInTheDocument();
    expect(await screen.findByText("Modifications didn't load, so sets log without them.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
    expect(createdBody(0)).not.toHaveProperty('modifications');
    expect(screen.getByText('225 lbs × 5')).toBeInTheDocument();
  });

  it("starts from the occurrence's last logged set", async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockResolvedValue([PAUSED]);
    mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, id: 'rec-2', setNum: 2 });
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets({ ...LOGGED, modifications: PAUSED_REF })] })} />);

    expect(screen.getByText('225 lbs × 5 · Paused')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Paused', pressed: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() =>
      expect(createdBody(0)).toEqual(expect.objectContaining({ setNum: 2, modifications: ['m-paused'] })),
    );
  });

  it('keeps a toggle changed after a logged set across a reload, and clears it when the next set logs', async () => {
    const user = userEvent.setup();
    const draftKey = buildModificationsDraftKey('5-3-1', 1, 1, 'Back Squat');
    mockFetchLiftModifications.mockResolvedValue([PAUSED]);
    mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, id: 'rec-2', setNum: 2 });
    const lifts = [twoSets({ ...LOGGED, modifications: PAUSED_REF })];
    const { unmount } = render(<WorkoutLogger {...makeProps({ lifts })} />);
    await user.click(await screen.findByRole('button', { name: 'Paused', pressed: true }));
    unmount();

    // The page reloads: set 1 still names Paused, but the lifter turned it off for set 2.
    render(<WorkoutLogger {...makeProps({ lifts })} />);
    expect(await screen.findByRole('button', { name: 'Paused', pressed: false })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Log' }));

    await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
    expect(createdBody(0)).not.toHaveProperty('modifications');
    expect(window.localStorage.getItem(draftKey)).toBeNull();
  });

  it('sends the starting toggles for a set logged before the list loads', async () => {
    const user = userEvent.setup();
    mockFetchLiftModifications.mockReturnValue(new Promise(() => {}));
    mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, id: 'rec-2', setNum: 2, modifications: PAUSED_REF });
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets({ ...LOGGED, modifications: PAUSED_REF })] })} />);

    expect(screen.queryByRole('group', { name: 'Back Squat modifications' })).not.toBeInTheDocument();
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

  it('keeps the typed set and says the log failed when the refresh after a 400 fails too', async () => {
    const user = userEvent.setup();
    const refreshFailure = new Error('API 503 Service Unavailable for /lifts/modifications');
    mockFetchLiftModifications.mockResolvedValueOnce([PAUSED]).mockRejectedValueOnce(refreshFailure);
    mockCreateLiftRecord.mockRejectedValue(
      new ApiClientError("'m-paused' is not one of your modifications of Back Squat", 400),
    );
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(await screen.findByRole('button', { name: 'Paused', pressed: false }));
    await user.clear(screen.getByLabelText('Weight in lbs'));
    await user.type(screen.getByLabelText('Weight in lbs'), '230');
    await user.click(screen.getByRole('button', { name: 'Log' }));

    expect(await screen.findByText('Failed to log set. Try again.')).toBeInTheDocument();
    expect(mockLogClientError).toHaveBeenCalledWith('fetchLiftModifications', refreshFailure, {
      program: '5-3-1',
      lift: 'Back Squat',
    });
    // The toggles already showing stay, and so does the typed set.
    expect(screen.getByRole('button', { name: 'Paused', pressed: true })).toBeInTheDocument();
    expect(screen.getByLabelText('Weight in lbs')).toHaveValue(230);
  });

  it('adds a modification inline and turns it on', async () => {
    const user = userEvent.setup();
    mockCreateLiftModification.mockResolvedValue({ ok: true, data: PAUSED });
    // Strict Mode, as `next dev` runs it: the toggles' updater runs twice and must still end on.
    render(
      <StrictMode>
        <WorkoutLogger {...makeProps()} />
      </StrictMode>,
    );

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

  it('keeps a refresh that landed while an inline Add was saving', async () => {
    const user = userEvent.setup();
    const OLD = modification('m-old', 'Old grip');
    const WIDE = modification('m-wide', 'Wide stance');
    let resolveAdd: (value: { ok: true; data: LiftModificationResponse }) => void = () => {};
    // The refresh already lists the modification the Add is creating.
    mockFetchLiftModifications.mockResolvedValueOnce([PAUSED, OLD]).mockResolvedValueOnce([PAUSED, WIDE]);
    mockCreateLiftRecord.mockRejectedValue(
      new ApiClientError("'m-old' is not one of your modifications of Back Squat", 400),
    );
    mockCreateLiftModification.mockReturnValue(new Promise((resolve) => { resolveAdd = resolve; }));
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(await screen.findByRole('button', { name: 'Old grip', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'Add modification' }));
    await user.type(screen.getByLabelText('Modification name'), 'Wide stance');
    await user.click(screen.getByRole('button', { name: 'Save modification' }));
    // While the Add saves, a log finds Old grip removed elsewhere and refreshes the list.
    await user.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByText(/A modification on this set was removed/)).toBeInTheDocument();
    resolveAdd({ ok: true, data: WIDE });

    expect(await screen.findByRole('button', { name: 'Wide stance', pressed: true })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Wide stance' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Old grip' })).not.toBeInTheDocument();
  });

  it('keeps a toggle changed while a set was logging saved for the next set', async () => {
    const user = userEvent.setup();
    const draftKey = buildModificationsDraftKey('5-3-1', 1, 1, 'Back Squat');
    let resolveLog: (record: LiftRecordResponse) => void = () => {};
    mockFetchLiftModifications.mockResolvedValue([PAUSED]);
    mockCreateLiftRecord.mockReturnValue(new Promise((resolve) => { resolveLog = resolve; }));
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets()] })} />);

    await screen.findByRole('button', { name: 'Paused', pressed: false });
    const [logSet1] = screen.getAllByRole('button', { name: 'Log' });
    if (!logSet1) throw new Error('expected a Log button for set 1');
    await user.click(logSet1);
    await user.click(screen.getByRole('button', { name: 'Paused', pressed: false }));
    resolveLog(LOGGED);

    expect(await screen.findByText('225 lbs × 5')).toBeInTheDocument();
    expect(window.localStorage.getItem(draftKey)).toBe('["m-paused"]');
  });

  it("shows the API's reason for a coded 400 rather than the removed message", async () => {
    const user = userEvent.setup();
    const reason = 'A set can have only one modification with its own max';
    mockFetchLiftModifications.mockResolvedValue([modification('m-wide', 'Wide grip', { maxMode: 'own' })]);
    mockCreateLiftRecord.mockRejectedValue(new ApiClientError(reason, 400, 'one-own-modification'));
    render(<WorkoutLogger {...makeProps()} />);

    await user.click(await screen.findByRole('button', { name: 'Wide grip', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'Log' }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(mockFetchLiftModifications).toHaveBeenCalledTimes(1);
  });

  it('closes a half-typed Add when the lifter moves to another lift', async () => {
    const user = userEvent.setup();
    render(
      <WorkoutLogger
        {...makeProps({ lifts: [makeLift(), makeLift({ lift: 'Bench Press' })] })}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Add modification' }));
    await user.type(screen.getByLabelText('Modification name'), 'Paused');
    await user.click(screen.getByRole('button', { name: 'Go to Bench Press' }));

    expect(await screen.findByRole('heading', { name: 'Bench Press' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Modification name')).not.toBeInTheDocument();
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

  it('drops a toggle removed elsewhere from the next save of an edit', async () => {
    const user = userEvent.setup();
    const WIDE = modification('m-wide', 'Wide stance');
    mockFetchLiftModifications.mockResolvedValueOnce([WIDE]).mockResolvedValue([]);
    mockUpdateLiftRecord
      .mockRejectedValueOnce(new ApiClientError("'m-wide' is not one of your modifications of Back Squat", 400))
      .mockResolvedValueOnce(LOGGED);
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets(LOGGED)] })} />);

    await screen.findByRole('button', { name: 'Wide stance', pressed: false });
    await user.click(screen.getByRole('button', { name: 'Edit set 1' }));
    const editToggles = within(screen.getByRole('group', { name: 'Set 1 modifications' }));
    await user.click(editToggles.getByRole('button', { name: 'Wide stance', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/A modification on this set was removed/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdateLiftRecord).toHaveBeenCalledTimes(2));
    expect(mockUpdateLiftRecord.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ modifications: ['m-wide'] }));
    expect(mockUpdateLiftRecord.mock.calls[1]?.[2]).not.toHaveProperty('modifications');
  });

  it("shows the API's reason when an edit adds a second modification with its own max", async () => {
    const user = userEvent.setup();
    const WIDE = modification('m-wide', 'Wide grip', { maxMode: 'own' });
    const reason = 'A set can have only one modification with its own max';
    mockFetchLiftModifications.mockResolvedValue([WIDE]);
    mockUpdateLiftRecord.mockRejectedValue(new ApiClientError(reason, 400, 'one-own-modification'));
    // The set names an archived modification with its own max, which the list leaves out.
    const archived = [{ id: 'm-close', name: 'Close grip' }];
    render(<WorkoutLogger {...makeProps({ lifts: [twoSets({ ...LOGGED, modifications: archived })] })} />);

    await screen.findByRole('button', { name: 'Wide grip', pressed: false });
    await user.click(screen.getByRole('button', { name: 'Edit set 1' }));
    const editToggles = within(screen.getByRole('group', { name: 'Set 1 modifications' }));
    expect(editToggles.getByRole('button', { name: 'Close grip', pressed: true })).toBeInTheDocument();
    await user.click(editToggles.getByRole('button', { name: 'Wide grip', pressed: false }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/A modification on this set was removed/)).not.toBeInTheDocument();
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

  describe('own max re-planning (#1153)', () => {
    // One warm-up at 50% and two work sets at 100%, so each plan reads straight off its max.
    const SPEC: LiftingProgramSpecResponse = {
      week: 1,
      lift: 'Back Squat',
      order: 1,
      offset: 0,
      increment: 5,
      sets: 2,
      reps: 5,
      amrap: false,
      warmUpPct: '0.5',
      wtDecrementPct: 0,
      activation: '',
    };
    const planned = (liftMax: number) =>
      makeLift({
        warmUpSets: [{ reps: 5, totalLoad: liftMax / 2 }],
        workingSets: [
          { setNum: 1, totalLoad: liftMax, reps: 5, amrap: false },
          { setNum: 2, totalLoad: liftMax, reps: 5, amrap: false },
        ],
        plan: { spec: SPEC, liftMax },
      });
    const WIDE = modification('m-wide', 'Wide grip', { maxMode: 'own' });
    const CLOSE = modification('m-close', 'Close grip', { maxMode: 'own' });
    const weights = () => screen.getAllByLabelText('Weight in lbs').map((i) => (i as HTMLInputElement).value);
    const warmUp = () => within(screen.getByRole('region', { name: 'Warm-up sets' })).getByText(/×/).textContent;

    it("re-plans from the modification's own max, with one own toggle on, and keeps a typed weight", async () => {
      const user = userEvent.setup();
      mockFetchLiftModifications.mockResolvedValue([WIDE, CLOSE, PAUSED]);
      render(<WorkoutLogger {...makeProps({ lifts: [planned(200)], ownMaxes: { 'm-wide': 150, 'm-close': 180 } })} />);

      await user.click(await screen.findByRole('button', { name: 'Paused', pressed: false }));
      expect(weights()).toEqual(['200', '200']);
      expect(warmUp()).toBe('100 lbs × 5');

      await user.click(screen.getByRole('button', { name: 'Wide grip', pressed: false }));
      expect(weights()).toEqual(['150', '150']);
      expect(warmUp()).toBe('75 lbs × 5');
      expect(screen.getByText("Planned from Wide grip's own max.")).toBeInTheDocument();

      // A weight the lifter typed is theirs: a re-plan leaves it.
      const [, set2] = screen.getAllByLabelText('Weight in lbs');
      if (!set2) throw new Error('expected a weight input for set 2');
      await user.clear(set2);
      await user.type(set2, '160');

      await user.click(screen.getByRole('button', { name: 'Close grip', pressed: false }));
      expect(weights()).toEqual(['180', '160']);
      expect(warmUp()).toBe('90 lbs × 5');
      expect(screen.getAllByRole('button', { pressed: true }).map((b) => b.textContent)).toEqual([
        'Close grip',
        'Paused',
      ]);

      // Off again, the lift's own max plans it; a modification with no own max (Paused) doesn't.
      await user.click(screen.getByRole('button', { name: 'Close grip', pressed: true }));
      expect(weights()).toEqual(['200', '160']);
      expect(warmUp()).toBe('100 lbs × 5');
    });

    it('logs the re-planned weight', async () => {
      const user = userEvent.setup();
      mockFetchLiftModifications.mockResolvedValue([WIDE]);
      mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, weight: 150, modifications: [{ id: 'm-wide', name: 'Wide grip' }] });
      render(<WorkoutLogger {...makeProps({ lifts: [planned(200)], ownMaxes: { 'm-wide': 150 } })} />);

      await user.click(await screen.findByRole('button', { name: 'Wide grip', pressed: false }));
      const [logSet1] = screen.getAllByRole('button', { name: 'Log' });
      if (!logSet1) throw new Error('expected a Log button for set 1');
      await user.click(logSet1);

      await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
      expect(createdBody(0)).toEqual(expect.objectContaining({ weight: 150, modifications: ['m-wide'] }));
    });

    it('plans from the lift max, and says so, when the modification has no max yet', async () => {
      const user = userEvent.setup();
      mockFetchLiftModifications.mockResolvedValue([WIDE]);
      render(<WorkoutLogger {...makeProps({ lifts: [planned(200)], ownMaxes: {} })} />);

      await user.click(await screen.findByRole('button', { name: 'Wide grip', pressed: false }));

      expect(weights()).toEqual(['200', '200']);
      expect(
        screen.getByText("Wide grip has no max of its own yet, so this plans from Back Squat's. Sets logged with it start one when maxes next move."),
      ).toBeInTheDocument();
    });

    it("plans from the lift max, and says so, when the own maxes didn't load", async () => {
      const user = userEvent.setup();
      mockFetchLiftModifications.mockResolvedValue([WIDE]);
      render(<WorkoutLogger {...makeProps({ lifts: [planned(200)], ownMaxes: null })} />);

      await user.click(await screen.findByRole('button', { name: 'Wide grip', pressed: false }));

      expect(weights()).toEqual(['200', '200']);
      expect(screen.getByText("Wide grip's own max didn't load, so this plans from Back Squat's.")).toBeInTheDocument();
    });

    it('re-plans a lift it starts on with an own modification from its last logged set', async () => {
      mockFetchLiftModifications.mockResolvedValue([WIDE]);
      const lift = planned(200);
      const [set1, set2] = lift.workingSets;
      if (!set1 || !set2) throw new Error('expected two working sets');
      render(
        <WorkoutLogger
          {...makeProps({
            lifts: [
              {
                ...lift,
                workingSets: [
                  { ...set1, existing: { ...LOGGED, weight: 150, modifications: [{ id: 'm-wide', name: 'Wide grip' }] } },
                  set2,
                ],
              },
            ],
            ownMaxes: { 'm-wide': 150 },
          })}
        />,
      );

      expect(await screen.findByRole('button', { name: 'Wide grip', pressed: true })).toBeInTheDocument();
      expect(weights()).toEqual(['150']);
      expect(warmUp()).toBe('75 lbs × 5');
    });

    it('plans from the own max a lift starts on before its list loads, so a set logged then sends a matching weight', async () => {
      const user = userEvent.setup();
      mockFetchLiftModifications.mockReturnValue(new Promise(() => undefined));
      mockCreateLiftRecord.mockResolvedValue({ ...LOGGED, setNum: 2, weight: 150 });
      const lift = planned(200);
      const [set1, set2] = lift.workingSets;
      if (!set1 || !set2) throw new Error('expected two working sets');
      render(
        <WorkoutLogger
          {...makeProps({
            lifts: [
              {
                ...lift,
                workingSets: [
                  { ...set1, existing: { ...LOGGED, weight: 150, modifications: [{ id: 'm-wide', name: 'Wide grip' }] } },
                  set2,
                ],
              },
            ],
            ownMaxes: { 'm-wide': 150 },
          })}
        />,
      );

      expect(weights()).toEqual(['150']);
      await user.click(screen.getByRole('button', { name: 'Log' }));
      await waitFor(() => expect(mockCreateLiftRecord).toHaveBeenCalledTimes(1));
      expect(createdBody(0)).toEqual(expect.objectContaining({ weight: 150, modifications: ['m-wide'] }));
    });

    it("plans the server render from the lift's max, whatever this device's saved toggle, so hydration matches", () => {
      const lift = planned(200);
      window.localStorage.setItem(
        buildModificationsDraftKey('5-3-1', 1, 1, lift.lift),
        JSON.stringify(['m-wide']),
      );
      const container = document.createElement('div');
      container.innerHTML = renderToString(
        <WorkoutLogger {...makeProps({ lifts: [lift], ownMaxes: { 'm-wide': 150 } })} />,
      );

      const serverWeights = within(container)
        .getAllByLabelText('Weight in lbs')
        .map((i) => (i as HTMLInputElement).value);
      expect(serverWeights).toEqual(['200', '200']);
    });

    it('restores an untyped weight at the current plan after a reload, whatever the toggle was when it was saved', async () => {
      const user = userEvent.setup();
      mockFetchLiftModifications.mockResolvedValue([WIDE]);
      const props = makeProps({ lifts: [planned(200)], ownMaxes: { 'm-wide': 150 } });
      const first = render(<WorkoutLogger {...props} />);

      // Notes typed while the own toggle is on save the set's draft with the own plan's weight.
      await user.click(await screen.findByRole('button', { name: 'Wide grip', pressed: false }));
      const notes = screen.getAllByLabelText('Notes (optional)')[1];
      if (!notes) throw new Error('expected a notes input for set 2');
      await user.type(notes, 'x');
      await user.click(screen.getByRole('button', { name: 'Wide grip', pressed: true }));
      expect(weights()).toEqual(['200', '200']);
      first.unmount();

      // Reloaded with the toggle off, the set plans from the lift's max and still follows the plan.
      render(<WorkoutLogger {...props} />);
      await user.click(await screen.findByRole('button', { name: 'Wide grip', pressed: false }));
      expect(weights()).toEqual(['150', '150']);
      await user.click(screen.getByRole('button', { name: 'Wide grip', pressed: true }));
      expect(weights()).toEqual(['200', '200']);
    });

    it('keeps a weight typed before a reload', async () => {
      const user = userEvent.setup();
      mockFetchLiftModifications.mockResolvedValue([WIDE]);
      const props = makeProps({ lifts: [planned(200)], ownMaxes: { 'm-wide': 150 } });
      const first = render(<WorkoutLogger {...props} />);

      await screen.findByRole('button', { name: 'Wide grip', pressed: false });
      const [, set2] = screen.getAllByLabelText('Weight in lbs');
      if (!set2) throw new Error('expected a weight input for set 2');
      await user.clear(set2);
      await user.type(set2, '200');
      first.unmount();

      render(<WorkoutLogger {...props} />);
      await user.click(await screen.findByRole('button', { name: 'Wide grip', pressed: false }));
      expect(weights()).toEqual(['150', '200']);
    });
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
