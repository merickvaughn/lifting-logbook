import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RescheduleForm from './RescheduleForm';
import { rescheduleWorkout } from '@/lib/client-api';

// The headline case from #783: this form used to `catch {}` and discard the error, so a
// production reschedule failure surfaced only as a generic string with nothing logged.
const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

jest.mock('@/lib/client-api', () => ({
  rescheduleWorkout: jest.fn(),
}));

const mockReschedule = rescheduleWorkout as jest.MockedFunction<typeof rescheduleWorkout>;

function renderForm() {
  return render(
    <RescheduleForm program="5-3-1" macrocycleNum={1} workoutNum={2} currentDate="2026-07-08" />,
  );
}

async function openAndPickDate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Reschedule/ }));
  // A type="date" input is unreliable to drive with userEvent.type in jsdom; set it directly.
  fireEvent.change(screen.getByLabelText('New date'), { target: { value: '2026-07-15' } });
}

describe('RescheduleForm — mutation failure logging (#783)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('captures the underlying error and still shows the generic message on failure', async () => {
    const user = userEvent.setup();
    const failure = new Error('API 500 Internal Server Error for /reschedule');
    mockReschedule.mockRejectedValue(failure);

    renderForm();
    await openAndPickDate(user);
    await user.click(screen.getByRole('button', { name: 'Move' }));

    // Generic user-facing message is preserved — no UX regression.
    await waitFor(() =>
      expect(screen.getByText('Failed to reschedule. Please try again.')).toBeInTheDocument(),
    );
    // ...and the real error is captured for production diagnosis rather than swallowed.
    expect(errorSpy).toHaveBeenCalledWith(
      '[client-mutation] rescheduleWorkout failed',
      failure,
      expect.objectContaining({ program: '5-3-1', macrocycleNum: 1, workoutNum: 2 }),
    );
  });

  it('refreshes on success without logging an error', async () => {
    const user = userEvent.setup();
    mockReschedule.mockResolvedValue(undefined);

    renderForm();
    await openAndPickDate(user);
    await user.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(mockReschedule).toHaveBeenCalledWith('5-3-1', 1, 2, '2026-07-15');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
