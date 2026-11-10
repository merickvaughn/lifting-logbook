import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchLiftMetadata: jest.fn(),
}));

jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
}));

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  redirect: jest.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

jest.mock('@/components/LiftEditor', () => ({
  __esModule: true,
  default: ({ initialMetadata }: { initialMetadata: { lift: string; muscleGroups: string[] } }) => (
    <div>
      lift-editor:{initialMetadata.lift}:{initialMetadata.muscleGroups.join(',')}
    </div>
  ),
}));

import { notFound } from 'next/navigation';
import { fetchLiftMetadata, fetchWorkout } from '@/lib/api';
import EditLiftPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedMetadata = fetchLiftMetadata as unknown as jest.Mock;
const mockedNotFound = notFound as unknown as jest.Mock;

const workout = (...lifts: string[]) => ({
  macrocycleNum: 1,
  week: 1,
  lifts: lifts.map((lift) => ({ lift, planned: true, sets: [] })),
});

const metadata = (lift: string) => ({
  lift,
  muscleGroups: ['quads'],
  substitutions: [],
  foundational: true,
});

async function renderEdit(lift: string): Promise<string> {
  const element = (await EditLiftPage({
    params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1', lift: encodeURIComponent(lift) }),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('EditLiftPage (#1190)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWorkout.mockResolvedValue(workout('squat', 'deadlift'));
    mockedMetadata.mockImplementation(async (lift: string) => metadata(lift));
  });

  it('opens the editor with the API metadata for a lift in the workout', async () => {
    const html = await renderEdit('squat');

    expect(html).toContain('Edit Lift: squat');
    expect(html).toContain('lift-editor:squat:quads');
    expect(mockedWorkout).toHaveBeenCalledWith('5-3-1', 1);
    expect(mockedMetadata).toHaveBeenCalledWith('squat');
  });

  it('decodes the lift segment before looking it up', async () => {
    mockedWorkout.mockResolvedValue(workout('Front Squat'));

    expect(await renderEdit('Front Squat')).toContain('lift-editor:Front Squat:quads');
    expect(mockedMetadata).toHaveBeenCalledWith('Front Squat');
  });

  it('matches a lift the workout stores under another spelling', async () => {
    mockedWorkout.mockResolvedValue(workout('Bench Press'));

    expect(await renderEdit('bench-press')).toContain('lift-editor:bench-press:quads');
  });

  it('404s a lift that is not in the workout, without fetching its metadata', async () => {
    await expect(renderEdit('not-a-lift')).rejects.toThrow('NOT_FOUND');
    expect(mockedMetadata).not.toHaveBeenCalled();
  });

  it('404s when the workout does not exist', async () => {
    mockedWorkout.mockResolvedValue(null);

    await expect(renderEdit('squat')).rejects.toThrow('NOT_FOUND');
  });

  // Only a missing workout or lift is a 404. fetchWorkout returns null for the API's 404 and
  // throws for anything else, which must reach the error boundary, not the not-found page.
  it('lets a failed workout fetch reach the error boundary', async () => {
    mockedWorkout.mockRejectedValue(new Error('API 503 Service Unavailable for /programs/5-3-1/workouts/1'));

    await expect(renderEdit('squat')).rejects.toThrow('API 503');
    expect(mockedNotFound).not.toHaveBeenCalled();
  });

  it('lets a failed metadata fetch reach the error boundary', async () => {
    mockedMetadata.mockRejectedValue(new Error('API 500 Internal Server Error for /lifts/squat/metadata'));

    await expect(renderEdit('squat')).rejects.toThrow('API 500');
    expect(mockedNotFound).not.toHaveBeenCalled();
  });

  it('redirects an old URL to the number the workout was read from (#1198)', async () => {
    mockedWorkout.mockResolvedValue({ ...workout('squat'), macrocycleNum: 2 });
    await expect(renderEdit('squat')).rejects.toThrow('REDIRECT:/macrocycle/2/workout/1/detail/manage-lifts/edit/squat');
  });
});
