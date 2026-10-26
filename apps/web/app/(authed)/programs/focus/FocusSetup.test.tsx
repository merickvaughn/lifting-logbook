import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { defaultPoolEntry } from '@lifting-logbook/core';
import {
  DEFAULT_FOCUS_TIMER,
  emptyFocusDayState,
  type FocusBlock,
  type FocusBlockResponse,
  type FocusDayPlanResponse,
} from '@lifting-logbook/types';
import {
  createFocusBlock,
  deleteFocusBlock,
  fetchFocusBlocks,
  fetchFocusPlan,
  fetchFocusSettings,
  reorderFocusBlocks,
  updateFocusBlock,
  updateFocusSettings,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { followOnBlock, newFocusBlock, type FocusWeekWorkout } from '@/lib/focusSetup';
import FocusSetup from './FocusSetup';

jest.mock('@/lib/client-api', () => ({
  createFocusBlock: jest.fn(),
  deleteFocusBlock: jest.fn(),
  fetchFocusBlocks: jest.fn(),
  fetchFocusPlan: jest.fn(),
  fetchFocusSettings: jest.fn(),
  reorderFocusBlocks: jest.fn(),
  updateFocusBlock: jest.fn(),
  updateFocusSettings: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/focusSetup', () => ({
  ...jest.requireActual('@/lib/focusSetup'),
  localToday: () => '2026-10-26',
}));

const TODAY = '2026-10-26';

const mocks = {
  create: createFocusBlock as jest.MockedFunction<typeof createFocusBlock>,
  remove: deleteFocusBlock as jest.MockedFunction<typeof deleteFocusBlock>,
  list: fetchFocusBlocks as jest.MockedFunction<typeof fetchFocusBlocks>,
  plan: fetchFocusPlan as jest.MockedFunction<typeof fetchFocusPlan>,
  settings: fetchFocusSettings as jest.MockedFunction<typeof fetchFocusSettings>,
  reorder: reorderFocusBlocks as jest.MockedFunction<typeof reorderFocusBlocks>,
  update: updateFocusBlock as jest.MockedFunction<typeof updateFocusBlock>,
  saveSettings: updateFocusSettings as jest.MockedFunction<typeof updateFocusSettings>,
  logError: logClientError as jest.MockedFunction<typeof logClientError>,
};

function block(overrides: Partial<FocusBlock> & Pick<FocusBlock, 'id'>): FocusBlockResponse {
  return {
    series: overrides.id,
    area: 'Shoulders',
    period: 'monthly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'reduce',
    progression: 'double',
    priority: 1,
    timer: { ...DEFAULT_FOCUS_TIMER },
    onEnd: 'prompt',
    nextArea: null,
    pool: [defaultPoolEntry('Lateral Raise')],
    // Status and range are what the API derives; the page derives its own from the dates.
    status: 'active',
    rangeStart: '2026-10-01',
    rangeEnd: '2026-10-31',
    ...overrides,
  };
}

// Shoulders: Q4, auto-rolls into Back (whose successor the API already created).
// Biceps: October, prompts, so it asks what follows (5 days left).
const SHOULDERS = block({ id: 'sh', series: 's1', period: 'quarterly', onEnd: 'autoroll', nextArea: 'Back' });
const BICEPS = block({ id: 'bi', series: 's2', area: 'Biceps', priority: 2 });
const BACK = block({ id: 'roll', series: 's1', area: 'Back', period: 'quarterly', start: '2027-01-01', priority: 3 });
const BLOCKS = [SHOULDERS, BICEPS, BACK];

const WORKOUTS: FocusWeekWorkout[] = [
  { workoutNum: 4, week: 2, date: '2026-10-26', done: false },
  { workoutNum: 5, week: 2, date: '2026-10-28', done: false },
];

function plan(workoutNum: number, overrides: Partial<FocusDayPlanResponse> = {}): FocusDayPlanResponse {
  const entry = defaultPoolEntry('Lateral Raise');
  return {
    program: '5-3-1',
    macrocycleNum: 1,
    workoutNum,
    today: TODAY,
    plannedLifts: ['Overhead Press'],
    budget: { sets: 9, minutes: 20 },
    dayState: emptyFocusDayState(),
    groups: [
      {
        block: SHOULDERS,
        mode: 'rules',
        items: [
          {
            lift: 'Lateral Raise',
            sets: 2,
            reducedFrom: 3,
            entry,
            prescription: { progression: 'double', sets: 2, repsLow: 10, repsHigh: 12, weight: 25, lastReps: null },
          },
        ],
        skipped: [],
        suggestions: [],
        overlap: { lifts: ['Overhead Press'], mode: 'reduce' },
        trimmed: [],
      },
    ],
    sets: 2,
    seconds: 300,
    over: false,
    suggestion: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <FocusSetup
      program="5-3-1"
      macrocycleNum={1}
      programLifts={['Squat', 'Overhead Press']}
      workouts={WORKOUTS}
      unit="lbs"
    />,
  );
}

// A stored copy the mocked writes change and the reads return, as the API would: the page
// re-reads after its saves, so a mock that ignored writes would undo every edit.
let stored: FocusBlockResponse[];
let storedGuide: { sets: number; minutes: number };

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  stored = BLOCKS.map((b) => ({ ...b }));
  storedGuide = { sets: 9, minutes: 20 };
  mocks.list.mockImplementation(async () => stored.map((b) => ({ ...b })));
  mocks.settings.mockImplementation(async () => ({ ...storedGuide }));
  mocks.plan.mockImplementation(async (_program, workoutNum) => plan(workoutNum));
  mocks.update.mockImplementation(async (id, patch) => {
    stored = stored.map((b) => (b.id === id ? { ...b, ...patch } : b));
    return stored.find((b) => b.id === id) ?? SHOULDERS;
  });
  mocks.create.mockImplementation(async (request) => {
    const created = block({ ...request, id: 'new', priority: 4 });
    stored = [...stored, created];
    return created;
  });
  mocks.remove.mockImplementation(async (id) => {
    stored = stored.filter((b) => b.id !== id);
  });
  mocks.reorder.mockImplementation(async (ids) => {
    stored = stored.map((b) => ({ ...b, priority: ids.indexOf(b.id) + 1 }));
    return stored;
  });
  mocks.saveSettings.mockImplementation(async (guide) => {
    storedGuide = { ...guide };
    return storedGuide;
  });
});

describe('FocusSetup', () => {
  it("loads the focus blocks for the user's calendar day and lists them", async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /Shoulders.*Quarterly · Q4 2026/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(TODAY);

    const toggles = screen.getAllByRole('button', { expanded: false });
    expect(toggles.map((t) => t.textContent)).toEqual([
      expect.stringContaining('Shoulders'),
      expect.stringContaining('Biceps'),
    ]);
    expect(screen.getByRole('button', { name: 'Raise priority of Shoulders' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Lower priority of Biceps' })).toBeDisabled();
  });

  it('lists the auto-roll successor under Up next, and Cancel deletes it', async () => {
    const user = userEvent.setup();
    renderPage();
    const upNext = (await screen.findByRole('heading', { name: 'Up next' })).nextElementSibling as HTMLElement;
    expect(within(upNext).getByText('Q1 2027 · auto-roll from Shoulders')).toBeInTheDocument();

    await user.click(within(upNext).getByRole('button', { name: 'Cancel Back (Q1 2027)' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('roll'));
    // The page re-reads once the save is done, picking up the declined roll.
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  });

  it('saves an edit to an open focus block with the day', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^›?\s*Biceps/ }));
    const period = screen.getByRole('radiogroup', { name: 'Period' });
    await user.click(within(period).getByRole('radio', { name: 'Quarterly' }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('bi', { period: 'quarterly' }, TODAY));
    expect(within(period).getByRole('radio', { name: 'Quarterly' })).toHaveAttribute('aria-checked', 'true');
  });

  it("shows this week's planned lifts that train the area in the overlap hint", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^›?\s*Shoulders/ }));
    expect(
      await screen.findByRole('group', { name: 'When planned work trains shoulders' }),
    ).toHaveAccessibleDescription(/This week, Overhead Press train shoulders\./);
  });

  it('saves pool edits as the whole pool', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^›?\s*Biceps/ }));
    await user.click(screen.getByRole('button', { name: 'Increase Sets (Lateral Raise)' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('bi', { pool: [{ ...defaultPoolEntry('Lateral Raise'), sets: 4 }] }, TODAY),
    );
  });

  it('adds a focus block for the first area without one, and opens it', async () => {
    const user = userEvent.setup();
    renderPage();
    const area = await screen.findByRole('combobox', { name: 'Area for a new focus block' });
    expect(area).toHaveValue('Triceps');
    await user.click(screen.getByRole('button', { name: '+ Add focus block' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(newFocusBlock('Triceps', TODAY), TODAY));
  });

  it('moves a focus block up by reordering every block that has not ended', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Raise priority of Biceps' }));
    await waitFor(() => expect(mocks.reorder).toHaveBeenCalledWith(['bi', 'sh', 'roll'], TODAY));
  });

  it('removes a focus block', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^›?\s*Biceps/ }));
    await user.click(screen.getByRole('button', { name: 'Remove this focus block' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('bi'));
    expect(screen.queryByRole('button', { name: /^›?\s*Biceps/ })).not.toBeInTheDocument();
  });

  describe('renewal prompt', () => {
    it('asks what follows a block ending within 10 days', async () => {
      renderPage();
      const prompt = await screen.findByRole('region', { name: 'Biceps focus block ending' });
      expect(within(prompt).getByText(/Biceps \(October 2026\) ends in 5 days/)).toBeInTheDocument();
    });

    it('renews into the next month in the same series', async () => {
      const user = userEvent.setup();
      renderPage();
      const prompt = await screen.findByRole('region', { name: 'Biceps focus block ending' });
      await user.click(within(prompt).getByRole('button', { name: 'Renew for November' }));
      await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(followOnBlock(BICEPS, 'Biceps'), TODAY));
    });

    it('queues a different area', async () => {
      const user = userEvent.setup();
      renderPage();
      const prompt = await screen.findByRole('region', { name: 'Biceps focus block ending' });
      await user.selectOptions(within(prompt).getByRole('combobox', { name: 'Area to follow Biceps' }), 'Core');
      await user.click(within(prompt).getByRole('button', { name: 'Queue' }));
      await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(followOnBlock(BICEPS, 'Core'), TODAY));
    });

    it('goes away on "Let it end" and stays away', async () => {
      const user = userEvent.setup();
      const { unmount } = renderPage();
      const prompt = await screen.findByRole('region', { name: 'Biceps focus block ending' });
      await user.click(within(prompt).getByRole('button', { name: 'Let it end' }));
      expect(screen.queryByRole('region', { name: 'Biceps focus block ending' })).not.toBeInTheDocument();
      unmount();

      renderPage();
      await screen.findByRole('button', { name: /^›?\s*Biceps/ });
      expect(screen.queryByRole('region', { name: 'Biceps focus block ending' })).not.toBeInTheDocument();
    });
  });

  it('saves the daily focus guide', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Increase Extra sets per day' }));
    await waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledWith({ sets: 10, minutes: 20 }));
    expect(screen.getByRole('status', { name: 'Extra sets per day' })).toHaveTextContent('10');
  });

  describe('This week', () => {
    it("lists each workout's focus lifts and totals against the guide", async () => {
      mocks.plan.mockImplementation(async (_program, workoutNum) =>
        plan(workoutNum, workoutNum === 5 ? { over: true, sets: 12, seconds: 1500 } : {}),
      );
      renderPage();
      expect(await screen.findByText('1 of 2 workouts over the guide')).toBeInTheDocument();
      expect(mocks.plan).toHaveBeenCalledWith('5-3-1', 4, TODAY);
      expect(mocks.plan).toHaveBeenCalledWith('5-3-1', 5, TODAY);
      expect(screen.getByText('Mon, Oct 26')).toBeInTheDocument();
      expect(screen.getAllByText('Lateral Raise')).toHaveLength(2);
      expect(screen.getByText('12 sets · 25 min')).toHaveClass('warnText');
      expect(screen.getByText('2 sets · 5 min')).not.toHaveClass('warnText');
    });

    it('says so when the plans fail to load, rather than showing an empty week', async () => {
      mocks.plan.mockRejectedValue(new Error('API 500'));
      renderPage();
      expect(await screen.findByText('Couldn’t load this week’s focus work.')).toBeInTheDocument();
      expect(screen.queryByText('Every workout fits the guide')).not.toBeInTheDocument();
      expect(mocks.logError).toHaveBeenCalledWith('fetchFocusPlan', expect.any(Error), {
        program: '5-3-1',
        workoutNums: [4, 5],
      });
    });
  });

  it('reports a failed save and re-reads the stored focus blocks', async () => {
    const user = userEvent.setup();
    const error = new Error('API 400');
    mocks.update.mockRejectedValue(error);
    renderPage();
    await user.click(await screen.findByRole('button', { name: /^›?\s*Biceps/ }));
    await user.click(within(screen.getByRole('radiogroup', { name: 'Progression' })).getByRole('radio', { name: 'RPE' }));

    expect(await screen.findByText(/A change didn’t save/)).toBeInTheDocument();
    expect(mocks.logError).toHaveBeenCalledWith('updateFocusBlock', error, { blockId: 'bi', fields: ['progression'] });
    // The re-read puts back what the API stored.
    await waitFor(() =>
      expect(within(screen.getByRole('radiogroup', { name: 'Progression' })).getByRole('radio', { name: 'Double progression' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
  });

  it('says so when the focus blocks fail to load', async () => {
    mocks.list.mockRejectedValueOnce(new Error('API 503'));
    renderPage();
    expect(await screen.findByText(/Couldn’t load your focus blocks/)).toBeInTheDocument();
    expect(mocks.logError).toHaveBeenCalledWith('fetchFocusBlocks', expect.any(Error));

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^›?\s*Shoulders/ })).toBeInTheDocument();
  });
});
