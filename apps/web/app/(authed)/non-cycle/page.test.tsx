import type { ReactElement } from 'react';
import type { NonCycleWorkoutResponse } from '@lifting-logbook/types';

jest.mock('@/lib/api', () => ({
  fetchLiftCatalog: jest.fn(),
  fetchNonCycleWorkout: jest.fn(),
}));
jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
}));
jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('kg'),
}));
jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
jest.mock('./NonCycleWorkout', () => ({ __esModule: true, default: () => null }));

import { fetchLiftCatalog, fetchNonCycleWorkout } from '@/lib/api';
import NewNonCycleWorkoutPage from './new/page';
import NonCycleWorkoutPage from './[workoutNum]/page';

const WORKOUT: NonCycleWorkoutResponse = { workoutNum: 2, date: '2026-11-10', macrocycleId: 'mc', records: [] };
const props = (element: unknown) => (element as ReactElement<Record<string, unknown>>).props;

describe('non-cycle workout pages (#1184)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes the active program’s lifts and the preferred unit to a new workout', async () => {
    (fetchLiftCatalog as jest.Mock).mockResolvedValue(['Squat']);
    expect(props(await NewNonCycleWorkoutPage())).toEqual({ program: '5-3-1', catalog: ['Squat'], unit: 'kg', workout: null });
    expect(fetchLiftCatalog).toHaveBeenCalledWith('5-3-1');
  });

  it('still opens with no suggestions when the lift list can’t be loaded', async () => {
    (fetchLiftCatalog as jest.Mock).mockRejectedValue(new Error('API unavailable'));
    expect(props(await NewNonCycleWorkoutPage())).toMatchObject({ catalog: [], workout: null });
    (fetchNonCycleWorkout as jest.Mock).mockResolvedValue(WORKOUT);
    expect(props(await NonCycleWorkoutPage({ params: Promise.resolve({ workoutNum: '2' }) }))).toMatchObject({
      catalog: [],
      workout: WORKOUT,
    });
  });

  it('reads the workout by its number, and is a 404 when there is none', async () => {
    (fetchLiftCatalog as jest.Mock).mockResolvedValue([]);
    (fetchNonCycleWorkout as jest.Mock).mockResolvedValue(WORKOUT);
    expect(props(await NonCycleWorkoutPage({ params: Promise.resolve({ workoutNum: '2' }) }))).toMatchObject({ workout: WORKOUT });
    expect(fetchNonCycleWorkout).toHaveBeenCalledWith(2);

    (fetchNonCycleWorkout as jest.Mock).mockResolvedValue(null);
    await expect(NonCycleWorkoutPage({ params: Promise.resolve({ workoutNum: '9' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(NonCycleWorkoutPage({ params: Promise.resolve({ workoutNum: 'x' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
