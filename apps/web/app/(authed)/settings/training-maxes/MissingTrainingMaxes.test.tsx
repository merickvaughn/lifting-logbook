import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MissingTrainingMaxResponse } from '@lifting-logbook/types';
import {
  fetchMissingTrainingMaxes,
  undismissMissingTrainingMax,
  updateTrainingMaxes,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import MissingTrainingMaxes from './MissingTrainingMaxes';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
jest.mock('@/lib/client-api', () => ({
  fetchMissingTrainingMaxes: jest.fn(),
  dismissMissingTrainingMax: jest.fn(),
  undismissMissingTrainingMax: jest.fn(),
  updateTrainingMaxes: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const mockFetch = fetchMissingTrainingMaxes as jest.MockedFunction<typeof fetchMissingTrainingMaxes>;
const mockUpdate = updateTrainingMaxes as jest.MockedFunction<typeof updateTrainingMaxes>;
const mockUndismiss = undismissMissingTrainingMax as jest.MockedFunction<typeof undismissMissingTrainingMax>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

const HEADING = 'Lifts without a training max';
const RDL: MissingTrainingMaxResponse = {
  lift: 'Romanian Deadlift',
  liftId: 'romanian-deadlift',
  lastLoggedDate: '2026-11-03',
  setCount: 12,
  estimate: { weight: 100, unit: 'lbs', from: { date: '2026-11-03', weight: 100, reps: 5 } },
  dismissed: false,
};
const CURL: MissingTrainingMaxResponse = {
  lift: 'Cable Curl',
  liftId: 'cable-curl',
  lastLoggedDate: '2026-10-28',
  setCount: 4,
  estimate: null,
  dismissed: true,
};

beforeEach(() => jest.clearAllMocks());

describe('Settings → Training Maxes: lifts without a training max (#1246, #1271)', () => {
  it('offers setup with the estimate prefilled, and saves that lift and weight', async () => {
    mockFetch.mockResolvedValue([RDL]);
    mockUpdate.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<MissingTrainingMaxes program="5-3-1" preferredUnit="lbs" step={5} />);

    expect(await screen.findByRole('heading', { name: HEADING })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith('5-3-1');
    expect(screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' })).toHaveValue(100);

    await user.click(screen.getByRole('button', { name: 'Set up' }));

    expect(mockUpdate).toHaveBeenCalledWith('5-3-1', {
      maxes: [{ lift: 'Romanian Deadlift', weight: 100, unit: 'lbs' }],
    });
    // The only lift now has a max, so the section goes, and the table refreshes to show it. Focus
    // moves to the status line, since the button it was on is gone.
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Training max set up for Romanian Deadlift.');
    expect(status).toHaveFocus();
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('lists a dismissed lift under Hidden from prompts, where Ask again clears it', async () => {
    mockFetch.mockResolvedValue([RDL, CURL]);
    mockUndismiss.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<MissingTrainingMaxes program="5-3-1" preferredUnit="lbs" step={5} />);

    const summary = await screen.findByText('Hidden from prompts (1)');
    const hidden = summary.closest('details');
    if (!hidden) throw new Error('no details element');
    expect(within(hidden).getByText('Cable Curl')).toBeInTheDocument();
    expect(within(hidden).queryByText('Romanian Deadlift')).not.toBeInTheDocument();

    await user.click(summary);
    await user.click(within(hidden).getByRole('button', { name: 'Ask again' }));

    expect(mockUndismiss).toHaveBeenCalledWith('5-3-1', 'cable-curl');
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Cable Curl will be asked about again.');
    expect(status).toHaveFocus();
    expect(screen.queryByText(/Hidden from prompts/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: "Don't ask again" })).toHaveLength(2);
  });

  it('shows nothing when no lift is missing a max', async () => {
    const empty = Promise.resolve([]);
    mockFetch.mockReturnValue(empty);
    const { container } = render(<MissingTrainingMaxes program="5-3-1" preferredUnit="lbs" step={5} />);

    // Let the list arrive and render before asserting.
    await act(() => empty);
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves the section out and logs the error when the list fails to load', async () => {
    const failure = new Error('API 500');
    mockFetch.mockRejectedValue(failure);
    render(<MissingTrainingMaxes program="5-3-1" preferredUnit="lbs" step={5} />);

    await waitFor(() =>
      expect(mockLog).toHaveBeenCalledWith('fetchMissingTrainingMaxes', failure, expect.objectContaining({ program: '5-3-1' })),
    );
    expect(screen.queryByRole('heading', { name: HEADING })).not.toBeInTheDocument();
  });
});
