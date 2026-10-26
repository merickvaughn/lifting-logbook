import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FocusCalendar from './FocusCalendar';
import {
  createFocusBlock,
  deleteFocusBlock,
  fetchFocusBlocks,
  fetchFocusBlockSummary,
} from '@/lib/client-api';
import { localIsoDate } from '@/lib/localDate';
import { logClientError } from '@/lib/log-client-error';
import { makeBlock } from '@/lib/__tests__/focusBlockFixture';

jest.mock('@/lib/client-api', () => ({
  createFocusBlock: jest.fn(),
  deleteFocusBlock: jest.fn(),
  fetchFocusBlocks: jest.fn(),
  fetchFocusBlockSummary: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/localDate', () => ({ localIsoDate: jest.fn() }));
const mockToday = localIsoDate as jest.MockedFunction<typeof localIsoDate>;

const mockFetchBlocks = fetchFocusBlocks as jest.MockedFunction<typeof fetchFocusBlocks>;
const mockSummary = fetchFocusBlockSummary as jest.MockedFunction<typeof fetchFocusBlockSummary>;
const mockDelete = deleteFocusBlock as jest.MockedFunction<typeof deleteFocusBlock>;
const mockCreate = createFocusBlock as jest.MockedFunction<typeof createFocusBlock>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

const pct = (days: number) => (days / 212) * 100;

const SHOULDERS = makeBlock({
  id: 'sh',
  series: 's1',
  period: 'quarterly',
  onEnd: 'autoroll',
  nextArea: 'Back',
  rangeEnd: '2026-12-31',
  pool: [{ ...poolEntry('Lateral Raise') }, { ...poolEntry('Face Pull') }],
});
const BACK_ROLL = makeBlock({
  id: 'back',
  series: 's1',
  area: 'Back',
  period: 'quarterly',
  status: 'queued',
  priority: 3,
  start: '2027-01-01',
  rangeStart: '2027-01-01',
  rangeEnd: '2027-03-31',
});
const BICEPS = makeBlock({ id: 'bi', series: 's2', area: 'Biceps', priority: 2, selection: 'rotate', overlap: 'anyway' });
const BICEPS_SEP = makeBlock({
  id: 'bi-sep',
  series: 's2',
  area: 'Biceps',
  priority: 9,
  status: 'ended',
  start: '2026-09-01',
  rangeStart: '2026-09-01',
  rangeEnd: '2026-09-30',
});

const BICEPS_NOV = makeBlock({
  id: 'bi-nov',
  series: 's2',
  area: 'Biceps',
  priority: 2,
  status: 'queued',
  start: '2026-11-01',
  rangeStart: '2026-11-01',
  rangeEnd: '2026-11-30',
});

function poolEntry(lift: string) {
  return {
    lift,
    include: 'auto' as const,
    ruleLift: '',
    swapTo: '',
    sets: 3,
    repsLow: 10,
    repsHigh: 12,
    weight: 25,
    trainingMax: 40,
    percent: 65,
    rpe: 8,
  };
}

const PHASES = [
  { name: 'Mesocycle 1', type: 'training' as const, start: '2026-09-07', end: '2026-09-21', weeks: 3 },
  { name: 'Mesocycle 2', type: 'training' as const, start: '2026-09-28', end: '2026-10-12', weeks: 3 },
];

function renderCalendar() {
  return render(<FocusCalendar phases={PHASES} unit="lbs" />);
}

function leftWidth(el: HTMLElement): [number, number] {
  return [parseFloat(el.style.left), parseFloat(el.style.width)];
}

describe('FocusCalendar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The prototype's "today", so the window is Sep 1 2026 – Mar 31 2027 (212 days).
    mockToday.mockReturnValue('2026-10-23');
    mockFetchBlocks.mockResolvedValue([SHOULDERS, BACK_ROLL, BICEPS, BICEPS_SEP]);
  });

  it('fetches focus blocks for the browser’s calendar day', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /Shoulders focus block/ });
    expect(mockFetchBlocks).toHaveBeenCalledWith('2026-10-23');
  });

  it('places each bar from its first day to the end of its last day', async () => {
    renderCalendar();
    const shoulders = await screen.findByRole('button', { name: 'Shoulders focus block, Q4 2026, active' });
    const [left, width] = leftWidth(shoulders);
    expect(left).toBeCloseTo(pct(30)); // Oct 1
    expect(width).toBeCloseTo(pct(92)); // Oct 1 – Dec 31

    const phase = screen.getByRole('button', { name: 'Mesocycle 2, Sep 28 – Oct 12, 2026' });
    expect(leftWidth(phase)[0]).toBeCloseTo(pct(27));
    expect(leftWidth(phase)[1]).toBeCloseTo(pct(15));
  });

  it('styles bars by status', async () => {
    renderCalendar();
    const active = await screen.findByRole('button', { name: 'Shoulders focus block, Q4 2026, active' });
    expect(active).toHaveClass('bar');
    expect(active).not.toHaveClass('ended');
    expect(active).not.toHaveClass('queued');
    expect(screen.getByRole('button', { name: 'Biceps focus block, September 2026, ended' })).toHaveClass('bar', 'ended');
    expect(screen.getByRole('button', { name: 'Back focus block, Q1 2027, queued' })).toHaveClass('bar', 'queued');
    expect(screen.getByRole('button', { name: /Mesocycle 1/ })).toHaveClass('bar', 'program');
  });

  it('puts one lane per series in priority order', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /Shoulders focus block/ });
    const areas = screen
      .getAllByRole('button', { name: /focus block/ })
      .map((b) => b.textContent);
    // Lane 1 (priority 1): Shoulders then Back; lane 2: Biceps Sep then Oct.
    expect(areas).toEqual(['Shoulders', 'Back', 'Biceps', 'Biceps']);
  });

  it('shows a phase’s dates and length', async () => {
    const user = userEvent.setup();
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /Mesocycle 1/ }));
    const card = screen.getByRole('region', { name: 'Selected program phase' });
    expect(within(card).getByText('Sep 7 – Sep 21, 2026 · 3 weeks')).toBeInTheDocument();
  });

  it('shows an active focus block’s progress and settings, with an edit link', async () => {
    const user = userEvent.setup();
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /Shoulders focus block/ }));
    const card = screen.getByRole('region', { name: 'Selected focus block' });
    expect(within(card).getByText('Week 4 of 14')).toBeInTheDocument();
    expect(within(card).getByText('Lateral Raise, Face Pull')).toBeInTheDocument();
    expect(within(card).getByText('Auto-roll to Back')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Edit in Programs' })).toHaveAttribute(
      'href',
      '/programs/focus?block=sh',
    );
    // Auto-rolling, so no renew prompt.
    expect(within(card).queryByText(/ends in/)).not.toBeInTheDocument();
  });

  it('prompts to renew a focus block ending within ten days, and queues the renewal at its priority', async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue(BICEPS_NOV);
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: 'Biceps focus block, October 2026, active' }));
    expect(screen.getByText('Biceps (October 2026) ends in 8 days')).toBeInTheDocument();

    mockFetchBlocks.mockResolvedValue([SHOULDERS, BACK_ROLL, BICEPS, BICEPS_SEP, BICEPS_NOV]);
    await user.click(screen.getByRole('button', { name: 'Renew for November' }));
    // Priority 2, like an auto-roll successor, not the bottom of the order.
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ series: 's2', area: 'Biceps', start: '2026-11-01', priority: 2 }),
      '2026-10-23',
    );
    expect(await screen.findByRole('button', { name: 'Biceps focus block, November 2026, queued' })).toBeInTheDocument();
    expect(screen.queryByText(/ends in 8 days/)).not.toBeInTheDocument();
    expect(mockFetchBlocks).toHaveBeenCalledTimes(2);
  });

  it('shows a saved renewal even when the refetch after it fails', async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue(BICEPS_NOV);
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: 'Biceps focus block, October 2026, active' }));

    mockFetchBlocks.mockRejectedValue(new Error('network'));
    await user.click(screen.getByRole('button', { name: 'Renew for November' }));
    expect(await screen.findByRole('button', { name: 'Biceps focus block, November 2026, queued' })).toBeInTheDocument();
    // The answered prompt goes away rather than sitting there disabled.
    expect(screen.queryByRole('button', { name: 'Renew for November' })).not.toBeInTheDocument();
  });

  it('prompts for an auto-roll with no next area, which would otherwise just end', async () => {
    const user = userEvent.setup();
    mockFetchBlocks.mockResolvedValue([{ ...BICEPS, onEnd: 'autoroll', nextArea: null }]);
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /Biceps focus block, October 2026/ }));
    expect(screen.getByText('Prompt me')).toBeInTheDocument();
    expect(screen.getByText('Biceps (October 2026) ends in 8 days')).toBeInTheDocument();
  });

  it('reads the day again when the tab comes back after midnight', async () => {
    renderCalendar();
    await screen.findByRole('button', { name: /Shoulders focus block/ });
    mockToday.mockReturnValue('2026-10-24');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(mockFetchBlocks).toHaveBeenLastCalledWith('2026-10-24'));
  });

  it('says so when there is no current macrocycle', async () => {
    render(<FocusCalendar phases={[]} unit="lbs" />);
    expect(await screen.findByText(/No current macrocycle/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a program' })).toHaveAttribute('href', '/programs');
  });

  it('queues a different area with that area’s default pool', async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue(makeBlock());
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: 'Biceps focus block, October 2026, active' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Next focus area' }), 'Triceps');
    await user.click(screen.getByRole('button', { name: 'Queue' }));
    const [body] = mockCreate.mock.calls[0] ?? [];
    expect(body?.area).toBe('Triceps');
    expect(body?.pool.length).toBeGreaterThan(0);
  });

  it('hides the renew prompt when the user lets the focus block end', async () => {
    const user = userEvent.setup();
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: 'Biceps focus block, October 2026, active' }));
    await user.click(screen.getByRole('button', { name: 'Let it end' }));
    expect(screen.queryByText(/ends in 8 days/)).not.toBeInTheDocument();
  });

  it('shows an ended focus block’s summary', async () => {
    const user = userEvent.setup();
    mockSummary.mockResolvedValue({
      blockId: 'bi-sep',
      rangeStart: '2026-09-01',
      rangeEnd: '2026-09-30',
      sessions: 12,
      sets: 68,
      volume: 18340,
      prs: [
        { lift: 'Hammer Curl', weight: 40, reps: 12, previousWeight: 35, previousReps: 12 },
        { lift: 'Incline DB Curl', weight: 25, reps: 12, previousWeight: 25, previousReps: 10 },
        // Decimal weights are legal; 12.3 − 10.1 is 2.2000000000000006 in floating point.
        { lift: 'Cable Curl', weight: 12.3, reps: 10, previousWeight: 10.1, previousReps: 10 },
      ],
    });
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /Biceps focus block, September 2026/ }));
    expect(mockSummary).toHaveBeenCalledWith('bi-sep');
    expect(await screen.findByText('18,340 lbs')).toBeInTheDocument();
    expect(screen.getByText('Hammer Curl: 40 lbs × 12 (+5 lbs)')).toBeInTheDocument();
    expect(screen.getByText('Incline DB Curl: 25 lbs × 12 (+2 reps)')).toBeInTheDocument();
    expect(screen.getByText('Cable Curl: 12.3 lbs × 10 (+2.2 lbs)')).toBeInTheDocument();
  });

  it('logs and reports a summary that fails to load', async () => {
    const user = userEvent.setup();
    const err = new Error('API 500');
    mockSummary.mockRejectedValue(err);
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /Biceps focus block, September 2026/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load this focus block’s summary.');
    expect(mockLog).toHaveBeenCalledWith('fetchFocusBlockSummary', err, { blockId: 'bi-sep' });
  });

  it('says a queued focus block auto-rolls, and cancels it', async () => {
    const user = userEvent.setup();
    mockDelete.mockResolvedValue(undefined);
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /Back focus block/ }));
    expect(screen.getByText('Auto-rolls from Shoulders when it ends.')).toBeInTheDocument();

    mockFetchBlocks.mockResolvedValue([{ ...SHOULDERS, onEnd: 'prompt' }, BICEPS, BICEPS_SEP]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDelete).toHaveBeenCalledWith('back');
    await waitFor(() => expect(screen.queryByRole('button', { name: /Back focus block/ })).not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Selected focus block' })).not.toBeInTheDocument();
  });

  it('logs and reports a cancel that fails, keeping the focus block', async () => {
    const user = userEvent.setup();
    const err = new Error('API 503');
    mockDelete.mockRejectedValue(err);
    renderCalendar();
    await user.click(await screen.findByRole('button', { name: /Back focus block/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t cancel this focus block.');
    expect(mockLog).toHaveBeenCalledWith('deleteFocusBlock', err, { blockId: 'back' });
    expect(screen.getByRole('button', { name: /Back focus block/ })).toBeInTheDocument();
  });

  it('logs and reports focus blocks that fail to load, still showing the program', async () => {
    const err = new Error('network');
    mockFetchBlocks.mockRejectedValue(err);
    renderCalendar();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load your focus blocks.');
    expect(mockLog).toHaveBeenCalledWith('fetchFocusBlocks', err, { today: '2026-10-23' });
    expect(screen.getByRole('button', { name: /Mesocycle 1/ })).toBeInTheDocument();
  });

  it('points to Programs when there are no focus blocks', async () => {
    mockFetchBlocks.mockResolvedValue([]);
    renderCalendar();
    expect(await screen.findByRole('link', { name: 'Add one in Programs' })).toHaveAttribute('href', '/programs/focus');
  });
});
