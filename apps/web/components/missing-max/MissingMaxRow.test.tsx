import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MissingTrainingMaxResponse } from '@lifting-logbook/types';
import {
  dismissMissingTrainingMax,
  undismissMissingTrainingMax,
  updateTrainingMaxes,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import { MissingMaxRow, shortDate, SkippedLiftRows } from './MissingMaxRow';

jest.mock('@/lib/client-api', () => ({
  dismissMissingTrainingMax: jest.fn(),
  undismissMissingTrainingMax: jest.fn(),
  updateTrainingMaxes: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const mockUpdate = updateTrainingMaxes as jest.MockedFunction<typeof updateTrainingMaxes>;
const mockDismiss = dismissMissingTrainingMax as jest.MockedFunction<typeof dismissMissingTrainingMax>;
const mockUndismiss = undismissMissingTrainingMax as jest.MockedFunction<typeof undismissMissingTrainingMax>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

// This year's date, so it reads without a year whenever the suite runs.
const DAY = `${new Date().getFullYear()}-11-03`;
const RDL: MissingTrainingMaxResponse = {
  lift: 'Romanian Deadlift',
  liftId: 'romanian-deadlift',
  lastLoggedDate: DAY,
  setCount: 12,
  estimate: { weight: 100, unit: 'lbs', from: { date: DAY, weight: 100, reps: 5 } },
  dismissed: false,
};

const renderRow = (entry: MissingTrainingMaxResponse = RDL, options: { preferredUnit?: 'lbs' | 'kg'; step?: number } = {}) => {
  const onSetUp = jest.fn();
  const onDismissedChange = jest.fn();
  render(
    <ul>
      <MissingMaxRow
        program="5-3-1"
        source="test"
        entry={entry}
        onSetUp={onSetUp}
        onDismissedChange={onDismissedChange}
        {...options}
      />
    </ul>,
  );
  return { onSetUp, onDismissedChange };
};

beforeEach(() => jest.clearAllMocks());

describe('MissingMaxRow (#1246)', () => {
  it('labels the input with its lift, prefilled with the estimate and described by its source', () => {
    renderRow();

    const input = screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' });
    expect(input).toHaveValue(100);
    expect(input).toHaveAccessibleDescription('Estimated from 100 lbs × 5 on 3 Nov');
    expect(screen.getByText('12 sets, last on 3 Nov')).toBeInTheDocument();
  });

  it('says there is nothing to estimate from when there is no estimate', () => {
    renderRow({ ...RDL, estimate: null });

    const input = screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' });
    expect(input).toHaveValue(null);
    expect(input).toHaveAccessibleDescription('No set to estimate from: enter a training max');
  });

  it('sets up the max with the weight entered', async () => {
    mockUpdate.mockResolvedValue([]);
    const user = userEvent.setup();
    const { onSetUp } = renderRow();

    const input = screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' });
    await user.clear(input);
    await user.type(input, '105');
    await user.click(screen.getByRole('button', { name: 'Set up' }));

    expect(mockUpdate).toHaveBeenCalledWith('5-3-1', {
      maxes: [{ lift: 'Romanian Deadlift', weight: 105, unit: 'lbs' }],
    });
    await waitFor(() => expect(onSetUp).toHaveBeenCalledWith('Romanian Deadlift', 105));
  });

  it('keeps the value and shows the error when the save fails', async () => {
    const failure = new Error('API 500');
    mockUpdate.mockRejectedValue(failure);
    const user = userEvent.setup();
    const { onSetUp } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Set up' }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the training max. Try again.");
    expect(screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' })).toHaveValue(100);
    expect(onSetUp).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('updateTrainingMaxes', failure, {
      program: '5-3-1',
      liftId: 'romanian-deadlift',
      source: 'test',
    });
  });

  it('refuses an empty weight without saving', async () => {
    const user = userEvent.setup();
    renderRow({ ...RDL, estimate: null });

    await user.click(screen.getByRole('button', { name: 'Set up' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a positive number');
    expect(screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' })).toHaveAccessibleDescription(
      'No set to estimate from: enter a training max Enter a positive number',
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("steps by the lifter's increment, and hints at the preferred unit", async () => {
    renderRow(RDL, { preferredUnit: 'kg', step: 5 });

    expect(screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' })).toHaveAttribute('step', '5');
    expect(screen.getByText('≈ 45.36 kg')).toBeInTheDocument();
  });

  it('gives no hint when the preferred unit is the stored one', () => {
    renderRow(RDL, { preferredUnit: 'lbs' });

    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
  });

  it("stores Don't ask again by lift id", async () => {
    mockDismiss.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onDismissedChange } = renderRow();

    await user.click(screen.getByRole('button', { name: "Don't ask again" }));

    expect(mockDismiss).toHaveBeenCalledWith('5-3-1', 'romanian-deadlift');
    await waitFor(() => expect(onDismissedChange).toHaveBeenCalledWith('romanian-deadlift', true));
  });

  it('offers Ask again for a dismissed lift, which clears the dismissal', async () => {
    mockUndismiss.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onDismissedChange } = renderRow({ ...RDL, dismissed: true });

    await user.click(screen.getByRole('button', { name: 'Ask again' }));

    expect(mockUndismiss).toHaveBeenCalledWith('5-3-1', 'romanian-deadlift');
    await waitFor(() => expect(onDismissedChange).toHaveBeenCalledWith('romanian-deadlift', false));
  });

  it('shows the error when a dismissal fails', async () => {
    const failure = new Error('API 500');
    mockDismiss.mockRejectedValue(failure);
    const user = userEvent.setup();
    const { onDismissedChange } = renderRow();

    await user.click(screen.getByRole('button', { name: "Don't ask again" }));

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that. Try again.");
    expect(onDismissedChange).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('dismissMissingTrainingMax', failure, expect.objectContaining({ source: 'test' }));
  });
});

describe('SkippedLiftRows (#1246)', () => {
  it('offers setup for a lift skipped for no training max, and explains any other reason', () => {
    render(
      <SkippedLiftRows
        program="5-3-1"
        source="test"
        skipped={[
          { lift: 'Romanian Deadlift', reason: 'no-training-max' },
          { lift: 'Cable Curl', reason: 'no-target-reps' },
        ]}
        missing={[RDL]}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Set up' })).toHaveLength(1);
    expect(screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' })).toHaveValue(100);
    expect(screen.queryByRole('spinbutton', { name: 'Cable Curl training max' })).not.toBeInTheDocument();
    expect(screen.getByText('Its progression needs a rep target, and none was set.')).toBeInTheDocument();
  });

  it('offers setup with no estimate when the missing list has no entry for the lift', () => {
    render(<SkippedLiftRows program="5-3-1" source="test" skipped={[{ lift: 'Romanian Deadlift', reason: 'no-training-max' }]} />);

    expect(screen.getByRole('spinbutton', { name: 'Romanian Deadlift training max' })).toHaveAccessibleDescription(
      'No set to estimate from: enter a training max',
    );
  });
});

describe('shortDate (#1246)', () => {
  const now = new Date(2026, 10, 13);

  it("leaves out this year's year", () => {
    expect(shortDate('2026-01-06', now)).toBe('6 Jan');
  });

  it('shows the year of an older date, so it reads as old', () => {
    expect(shortDate('2025-01-06', now)).toBe('6 Jan 2025');
  });
});
