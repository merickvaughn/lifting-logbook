import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchAllLiftMetadata: jest.fn(),
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
  default: ({
    program,
    initialMetadata,
    muscles,
    defaultMuscles,
  }: {
    program: string;
    initialMetadata: { lift: string; foundational: boolean };
    muscles: { primary: string[]; secondary: string[]; source: string };
    defaultMuscles: { primary: string[] } | null;
  }) => (
    <div>
      lift-editor:{program}:{initialMetadata.lift}:{String(initialMetadata.foundational)}|muscles:
      {muscles.source}:{muscles.primary.join(',')}/{muscles.secondary.join(',')}|defaults:
      {defaultMuscles ? defaultMuscles.primary.join(',') : 'none'}
    </div>
  ),
}));

import { notFound } from 'next/navigation';
import { fetchAllLiftMetadata, fetchWorkout } from '@/lib/api';
import EditLiftPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedMetadata = fetchAllLiftMetadata as unknown as jest.Mock;
const mockedNotFound = notFound as unknown as jest.Mock;

const workout = (...lifts: string[]) => ({
  macrocycleNum: 1,
  week: 1,
  lifts: lifts.map((lift) => ({ lift, planned: true, sets: [] })),
});

const row = (lift: string, muscleGroups: string[], foundational = true) => ({
  lift,
  muscleGroups,
  secondaryMuscleGroups: [],
  substitutions: [],
  foundational,
  progression: null,
  progressionIncrement: null,
  repsLow: null,
  repsHigh: null,
});

async function renderEdit(lift: string): Promise<string> {
  const element = (await EditLiftPage({
    params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1', lift: encodeURIComponent(lift) }),
  })) as ReactElement;
  // renderToStaticMarkup separates adjacent text nodes with comments; drop them.
  return renderToStaticMarkup(element).replace(/<!-- -->/g, '');
}

describe('EditLiftPage (#1190)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedWorkout.mockResolvedValue(workout('squat', 'deadlift'));
    mockedMetadata.mockResolvedValue([row('squat', ['quads']), row('deadlift', [])]);
  });

  it('opens the editor with the lift’s stored metadata', async () => {
    const html = await renderEdit('squat');

    expect(html).toContain('Edit Lift: squat');
    // The program too, whose own maxes the editor's modifications section edits (#1153).
    expect(html).toContain('lift-editor:5-3-1:squat:true');
    // Resolved over the list, so a legacy lowercase tag reads as the vocabulary's muscle.
    expect(html).toContain('muscles:custom:Quads/');
    expect(mockedWorkout).toHaveBeenCalledWith('5-3-1', 1);
  });

  it('gives a lift with no stored muscles its built-in defaults (#1017)', async () => {
    const html = await renderEdit('deadlift');
    expect(html).toContain('muscles:default:Glutes,Hamstrings,Lower Back/Quads,Traps,Upper Back,Forearms');
    expect(html).toContain('defaults:Glutes,Hamstrings,Lower Back');
  });

  it('decodes the lift segment before looking it up', async () => {
    mockedWorkout.mockResolvedValue(workout('Front Squat'));
    mockedMetadata.mockResolvedValue([row('Front Squat', ['Core'], false)]);

    const html = await renderEdit('Front Squat');
    expect(html).toContain('lift-editor:5-3-1:Front Squat:false');
    expect(html).toContain('muscles:custom:Core/');
  });

  // Before #1017 this page saved a multi-word lift under its URL-encoded name.
  it('fills the editor from a legacy URL-encoded row, under the real name', async () => {
    mockedWorkout.mockResolvedValue(workout('Front Squat'));
    mockedMetadata.mockResolvedValue([row('Front%20Squat', ['Core'])]);

    const html = await renderEdit('Front Squat');
    expect(html).toContain('lift-editor:5-3-1:Front Squat:true');
    expect(html).toContain('muscles:custom:Core/');
  });

  it('prefers the real-name row to a legacy one', async () => {
    mockedWorkout.mockResolvedValue(workout('Front Squat'));
    mockedMetadata.mockResolvedValue([row('Front%20Squat', ['Core']), row('Front Squat', ['Quads'], false)]);

    const html = await renderEdit('Front Squat');
    expect(html).toContain('lift-editor:5-3-1:Front Squat:false');
    expect(html).toContain('muscles:custom:Quads/');
  });

  it('gives a lift without built-in defaults none', async () => {
    mockedWorkout.mockResolvedValue(workout('Zercher Carry'));
    mockedMetadata.mockResolvedValue([]);

    const html = await renderEdit('Zercher Carry');
    expect(html).toContain('lift-editor:5-3-1:Zercher Carry:false');
    expect(html).toContain('muscles:none:/');
    expect(html).toContain('defaults:none');
  });

  it('matches a lift the workout stores under another spelling', async () => {
    mockedWorkout.mockResolvedValue(workout('Bench Press'));

    const html = await renderEdit('bench-press');
    expect(html).toContain('lift-editor:5-3-1:bench-press:false');
    expect(html).toContain('muscles:default:Chest/Triceps,Front Delts');
  });

  // The muscles come from the row the form fills from, so the editor never shows one row's
  // muscles beside another row's settings, and what it shows is what a save writes.
  it('takes the muscles from the same row as the rest of the form', async () => {
    mockedWorkout.mockResolvedValue(workout('Bench Press'));
    mockedMetadata.mockResolvedValue([row('Bench Press', ['Triceps'])]);

    const html = await renderEdit('bench-press');
    expect(html).toContain('lift-editor:5-3-1:bench-press:false');
    expect(html).toContain('muscles:default:Chest/');
  });

  it('ignores a row whose name only looks encoded', async () => {
    mockedWorkout.mockResolvedValue(workout('Front Squat'));
    // Decodes to "Front Squat", but encodeURIComponent writes "Front%20Squat".
    mockedMetadata.mockResolvedValue([row('Front%20Squa%74', ['Core'])]);

    const html = await renderEdit('Front Squat');
    expect(html).toContain('lift-editor:5-3-1:Front Squat:false');
    expect(html).toContain('muscles:default:');
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
    mockedMetadata.mockRejectedValue(new Error('API 500 Internal Server Error for /lifts/metadata'));

    await expect(renderEdit('squat')).rejects.toThrow('API 500');
    expect(mockedNotFound).not.toHaveBeenCalled();
  });

  it('redirects an old URL to the number the workout was read from (#1198)', async () => {
    mockedWorkout.mockResolvedValue({ ...workout('squat'), macrocycleNum: 2 });
    await expect(renderEdit('squat')).rejects.toThrow('REDIRECT:/macrocycle/2/workout/1/detail/manage-lifts/edit/squat');
  });
});
