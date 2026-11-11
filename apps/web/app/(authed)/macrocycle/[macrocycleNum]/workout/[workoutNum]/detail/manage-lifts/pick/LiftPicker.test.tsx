import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftOverrideResponse } from '@lifting-logbook/types';
import LiftPicker from './LiftPicker';
import { ApiClientError } from '@lifting-logbook/api-client';
import { upsertLiftOverride } from '@/lib/client-api';
import { browserNavigation } from '@/lib/macrocycleUrl';

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
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to save Back Squat. Please try again.');
  });

  it("shows the API's message while an import holds the lock (#1198)", async () => {
    const user = userEvent.setup();
    const msg = 'An import is changing your macrocycles. Try again in a moment.';
    mockUpsert.mockRejectedValue(new ApiClientError(msg, 409, 'import-in-progress'));

    renderPicker();
    await user.click(screen.getByRole('button', { name: 'Back Squat' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(msg));
  });

  it('reloads at the new number instead of showing an error when the macrocycle moved (#1198)', async () => {
    const user = userEvent.setup();
    const assign = jest.spyOn(browserNavigation, 'assign').mockImplementation(() => {});
    window.history.pushState({}, '', '/macrocycle/1/workout/2/detail/manage-lifts/pick?action=add');
    mockUpsert.mockRejectedValue(new ApiClientError('moved', 409, 'macrocycle-moved', { macrocycleNum: 2 }));

    renderPicker();
    await user.click(screen.getByRole('button', { name: 'Back Squat' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/macrocycle/2/workout/2/detail/manage-lifts/pick?action=add'));
    expect(screen.queryByRole('alert')).toBeNull();
    assign.mockRestore();
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
