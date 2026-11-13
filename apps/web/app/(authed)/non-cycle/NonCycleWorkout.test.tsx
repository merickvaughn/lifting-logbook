import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftRecordResponse, NonCycleWorkoutResponse } from '@lifting-logbook/types';
import NonCycleWorkout from './NonCycleWorkout';
import {
  createLiftRecord,
  createNonCycleWorkout,
  deleteNonCycleWorkout,
  fetchNonCycleReference,
  updateLiftRecord,
} from '@/lib/client-api';

const mockPush = jest.fn();
const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

jest.mock('@/lib/client-api', () => ({
  createLiftRecord: jest.fn(),
  createNonCycleWorkout: jest.fn(),
  deleteNonCycleWorkout: jest.fn(),
  fetchNonCycleReference: jest.fn(),
  updateLiftRecord: jest.fn(),
}));

const set = (id: string, setNum: number, weight: number, reps: number): LiftRecordResponse => ({
  id,
  program: 'non-cycle',
  macrocycleNum: 1,
  workoutNum: 3,
  date: '2026-11-10',
  lift: 'Squat',
  setNum,
  weight,
  reps,
  notes: '',
});

const WORKOUT: NonCycleWorkoutResponse = {
  workoutNum: 3,
  date: '2026-11-10',
  macrocycleId: 'mc-non-cycle',
  records: [set('s1', 1, 225, 5)],
};

function renderWorkout(workout: NonCycleWorkoutResponse | null, unit: 'lbs' | 'kg' = 'lbs') {
  return render(<NonCycleWorkout program="5-3-1" catalog={['Squat', 'Bench Press']} unit={unit} workout={workout} />);
}

async function enterSet(user: ReturnType<typeof userEvent.setup>, weight: string, reps: string) {
  await user.clear(screen.getByLabelText('Weight (lbs)'));
  await user.type(screen.getByLabelText('Weight (lbs)'), weight);
  await user.clear(screen.getByLabelText('Reps'));
  await user.type(screen.getByLabelText('Reps'), reps);
  await user.click(screen.getByRole('button', { name: 'Save set' }));
}

describe('NonCycleWorkout (#1184)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (fetchNonCycleReference as jest.Mock).mockResolvedValue({ lift: 'Squat', reference: null });
  });

  afterEach(() => errorSpy.mockRestore());

  it('starts the workout with its first set, then adds the next under its number and id', async () => {
    const user = userEvent.setup();
    (createNonCycleWorkout as jest.Mock).mockResolvedValue(WORKOUT);
    (createLiftRecord as jest.Mock).mockResolvedValue(set('s2', 2, 235, 3));
    const replaceState = jest.spyOn(window.history, 'replaceState');
    renderWorkout(null);

    const date = screen.getByLabelText('Date') as HTMLInputElement;
    await waitFor(() => expect(date.value).not.toBe(''));
    await user.clear(date);
    await user.type(date, '2026-11-10');
    await user.type(screen.getByLabelText('Lift'), 'Squat');
    await enterSet(user, '225', '5');

    expect(createNonCycleWorkout).toHaveBeenCalledWith({ date: '2026-11-10', lift: 'Squat', setNum: 1, weight: 225, reps: 5 });
    expect(await screen.findByRole('heading', { name: 'Non-cycle workout 3' })).toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/non-cycle/3');
    expect(date).toBeDisabled();

    await enterSet(user, '235', '3');
    expect(createLiftRecord).toHaveBeenCalledWith(
      'non-cycle',
      { program: 'non-cycle', macrocycleNum: 1, workoutNum: 3, date: '2026-11-10', lift: 'Squat', setNum: 2, weight: 235, reps: 3 },
      'mc-non-cycle',
    );
    expect(await screen.findByText(/Squat set 2:/)).toHaveTextContent('Squat set 2: 235 lbs × 3');
    replaceState.mockRestore();
  });

  it('shows the reference line for the lift in the preferred unit', async () => {
    (fetchNonCycleReference as jest.Mock).mockResolvedValue({
      lift: 'Squat',
      reference: { trainingMax: 205, previous: { weight: 200, reps: 8 } },
    });
    renderWorkout(WORKOUT);
    expect(await screen.findByText('Training max 205 lbs. Last at 200 lbs: 8 reps.')).toBeInTheDocument();
    expect(fetchNonCycleReference).toHaveBeenCalledWith('5-3-1', 'Squat');
  });

  it('reports a failed save and says so', async () => {
    const user = userEvent.setup();
    const failure = new Error('API 500');
    (createLiftRecord as jest.Mock).mockRejectedValue(failure);
    renderWorkout(WORKOUT);

    await enterSet(user, '225', '5');

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save the set.');
    expect(errorSpy).toHaveBeenCalledWith(
      '[client-mutation] createLiftRecord failed',
      failure,
      expect.objectContaining({ program: 'non-cycle', workoutNum: 3 }),
    );
  });

  it('edits a set', async () => {
    const user = userEvent.setup();
    (updateLiftRecord as jest.Mock).mockResolvedValue(set('s1', 1, 225, 7));
    renderWorkout(WORKOUT);

    await user.click(screen.getByRole('button', { name: 'Edit Squat set 1' }));
    const reps = screen.getAllByLabelText('Reps').at(-1) as HTMLInputElement;
    await user.clear(reps);
    await user.type(reps, '7');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateLiftRecord).toHaveBeenCalledWith('non-cycle', 's1', { weight: 225, reps: 7 }, 'mc-non-cycle');
    expect(await screen.findByText(/Squat set 1:/)).toHaveTextContent('225 lbs × 7');
  });

  it('deletes the workout once confirmed, and goes to History', async () => {
    const user = userEvent.setup();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    (deleteNonCycleWorkout as jest.Mock).mockResolvedValue(undefined);
    renderWorkout(WORKOUT);

    await user.click(screen.getByRole('button', { name: 'Delete workout' }));

    expect(deleteNonCycleWorkout).toHaveBeenCalledWith(3, 'mc-non-cycle');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/history'));
    confirm.mockRestore();
  });

  it('reports a failed delete and stays', async () => {
    const user = userEvent.setup();
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const failure = new Error('API 500');
    (deleteNonCycleWorkout as jest.Mock).mockRejectedValue(failure);
    renderWorkout(WORKOUT);

    await user.click(screen.getByRole('button', { name: 'Delete workout' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t delete the workout.');
    expect(errorSpy).toHaveBeenCalledWith('[client-mutation] deleteNonCycleWorkout failed', failure, { workoutNum: 3 });
    expect(mockPush).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
