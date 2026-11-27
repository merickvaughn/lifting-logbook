import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { complexLift } from '@lifting-logbook/core';
import type { BarbellComplexResponse, LiftingProgramSpecResponse } from '@lifting-logbook/types';
import { buildLiftDetails } from '@/lib/workoutPlan';
import { updateTrainingMaxes } from '@/lib/client-api';
import CollapsibleLiftList from './CollapsibleLiftList';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));
jest.mock('@/lib/client-api', () => ({
  updateTrainingMaxes: jest.fn(),
  dismissMissingTrainingMax: jest.fn(),
  undismissMissingTrainingMax: jest.fn(),
}));

const BEAR: BarbellComplexResponse = {
  id: 'c-bear',
  name: 'Bear',
  components: [
    { lift: 'Power Clean', reps: 2, name: 'Power Clean' },
    { lift: 'Front Squat', reps: 3, name: 'Front Squat' },
    { lift: 'Push Press', reps: 4, name: 'Push Press' },
  ],
  createdAt: '2026-11-27T00:00:00.000Z',
};

/** One warm-up at 70%, then a set at the max and one at 70%. */
const row: LiftingProgramSpecResponse = {
  week: 1,
  lift: complexLift(BEAR.id),
  order: 1,
  offset: 0,
  increment: 5,
  sets: 2,
  reps: 1,
  amrap: false,
  warmUpPct: '0.7',
  wtDecrementPct: 0.3,
  activation: '',
};

const workout = { week: 1, offset: 0, lifts: [{ lift: complexLift(BEAR.id), sets: [], planned: true }] };
const max = (lift: string, weight: number) => ({ lift, weight, dateUpdated: '2026-11-20' });

function renderList(maxes: ReturnType<typeof max>[]) {
  const liftDetails = buildLiftDetails(workout, [row], maxes, [], [BEAR]);
  return render(
    <CollapsibleLiftList liftDetails={liftDetails} macrocycleNum={1} workoutNum={1} unit="lbs" program="5-3-1" />,
  );
}

beforeEach(() => jest.clearAllMocks());

describe('CollapsibleLiftList — a complex slot (#1495)', () => {
  it('shows the complex by name with its lifts, planned weights and limiting lift', () => {
    renderList([max('Power Clean', 135), max('Front Squat', 185), max('Push Press', 155)]);

    expect(screen.getByRole('button', { name: /Bear/ })).toBeInTheDocument();
    expect(screen.queryByText(/complex:/)).not.toBeInTheDocument();
    // A complex has no lift history of its own.
    expect(screen.queryByRole('link', { name: /History/ })).not.toBeInTheDocument();

    const lifts = within(screen.getByRole('list', { name: 'Bear lifts' }));
    expect(lifts.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Power Clean × 2',
      'Front Squat × 3',
      'Push Press × 4',
    ]);
    expect(screen.getByText('Limited by Power Clean (135 lbs training max)')).toBeInTheDocument();
    // 70% of the weakest max (135), rounded to the 5 lb increment, then the max itself.
    expect(screen.getAllByText(/ × 95 lbs$/)).toHaveLength(2);
    expect(screen.getByText('1 × 135 lbs')).toBeInTheDocument();
  });

  it('leaves the complex unplanned while a lift has no max, and offers to set that max', async () => {
    const user = userEvent.setup();
    jest.mocked(updateTrainingMaxes).mockResolvedValue(undefined as never);
    renderList([max('Power Clean', 135), max('Push Press', 155)]);

    expect(screen.queryByText(/ × \d+ lbs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Limited by/)).not.toBeInTheDocument();
    expect(screen.getByText('Set a training max for each of its lifts to plan this complex.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Power Clean training max')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Front Squat training max'), '185');
    await user.click(screen.getByRole('button', { name: 'Set up' }));

    await waitFor(() =>
      expect(updateTrainingMaxes).toHaveBeenCalledWith('5-3-1', {
        maxes: [{ lift: 'Front Squat', weight: 185, unit: 'lbs' }],
      }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('offers no Don’t ask again for a lift the complex needs', () => {
    renderList([max('Power Clean', 135), max('Push Press', 155)]);
    expect(screen.getByLabelText('Front Squat training max')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ask again/i })).not.toBeInTheDocument();
  });

  it('shows a custom lift by name, and saves its max under its id', async () => {
    const user = userEvent.setup();
    jest.mocked(updateTrainingMaxes).mockResolvedValue(undefined as never);
    const hangBear: BarbellComplexResponse = {
      ...BEAR,
      components: [
        { lift: 'custom-hc', reps: 3, name: 'Hang Clean' },
        { lift: 'Front Squat', reps: 3, name: 'Front Squat' },
      ],
    };
    const liftDetails = buildLiftDetails(workout, [row], [max('Front Squat', 185)], [], [hangBear]);
    render(<CollapsibleLiftList liftDetails={liftDetails} macrocycleNum={1} workoutNum={1} unit="lbs" program="5-3-1" />);

    expect(screen.queryByText(/custom-hc/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Hang Clean training max'), '100');
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    await waitFor(() =>
      expect(updateTrainingMaxes).toHaveBeenCalledWith('5-3-1', {
        maxes: [{ lift: 'custom-hc', weight: 100, unit: 'lbs' }],
      }),
    );
  });

  it('shows the lifts of a complex the lifter named "Unknown complex"', () => {
    const liftDetails = buildLiftDetails(
      workout,
      [row],
      [max('Power Clean', 135), max('Front Squat', 185), max('Push Press', 155)],
      [],
      [{ ...BEAR, name: 'Unknown complex' }],
    );
    render(<CollapsibleLiftList liftDetails={liftDetails} macrocycleNum={1} workoutNum={1} unit="lbs" />);
    expect(screen.getByRole('list', { name: 'Unknown complex lifts' })).toBeInTheDocument();
    expect(screen.queryByText(/This complex was deleted/)).not.toBeInTheDocument();
  });

  it('says a deleted complex plans nothing', () => {
    const liftDetails = buildLiftDetails(workout, [row], [max('Power Clean', 135)], [], []);
    render(<CollapsibleLiftList liftDetails={liftDetails} macrocycleNum={1} workoutNum={1} unit="lbs" />);
    expect(screen.getByText(/This complex was deleted or couldn’t be read/)).toBeInTheDocument();
  });
});
