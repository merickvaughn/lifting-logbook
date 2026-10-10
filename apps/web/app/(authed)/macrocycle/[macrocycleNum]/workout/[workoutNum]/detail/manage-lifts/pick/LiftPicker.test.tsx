import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftOverrideResponse } from '@lifting-logbook/types';
import LiftPicker from './LiftPicker';
import { upsertLiftOverride } from '@/lib/client-api';

// Before #783 this picker had no catch at all, so a failed write became a silent unhandled
// rejection: no log, no message, the user just stranded on the picker. These lock the fix.
const mockPush = jest.fn();
const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

jest.mock('@/lib/client-api', () => ({
  upsertLiftOverride: jest.fn(),
}));

const mockUpsert = upsertLiftOverride as jest.MockedFunction<typeof upsertLiftOverride>;

function renderPicker() {
  return render(
    <LiftPicker
      program="5-3-1"
      macrocycleNum={1}
      workoutNum={2}
      action="add"
      catalog={['Back Squat', 'Bench Press']}
      backHref="/back"
    />,
  );
}

describe('LiftPicker — mutation failure logging (#783)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs the error and re-enables the control instead of leaving an unhandled rejection', async () => {
    const user = userEvent.setup();
    const failure = new Error('API 500 Internal Server Error for /lift-overrides');
    mockUpsert.mockRejectedValue(failure);

    renderPicker();
    await user.click(screen.getByRole('button', { name: 'Back Squat' }));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[client-mutation] upsertLiftOverride failed',
        failure,
        expect.objectContaining({ action: 'add', lift: 'Back Squat' }),
      ),
    );
    // The failure path must not navigate away, and the button re-enables for a retry.
    expect(mockPush).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Back Squat' })).toBeEnabled(),
    );
  });

  it('navigates back on success without logging an error', async () => {
    const user = userEvent.setup();
    mockUpsert.mockResolvedValue({} as unknown as LiftOverrideResponse);

    renderPicker();
    await user.click(screen.getByRole('button', { name: 'Bench Press' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/back'));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
