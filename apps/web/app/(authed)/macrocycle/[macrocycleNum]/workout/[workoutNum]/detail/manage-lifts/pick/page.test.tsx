import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchWorkout: jest.fn(),
  fetchLiftCatalog: jest.fn(),
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

jest.mock('./LiftPicker', () => ({
  __esModule: true,
  default: ({ macrocycleId, macrocycleNum }: { macrocycleId?: string; macrocycleNum: number }) => (
    <div>
      lift-picker:{macrocycleNum}:{macrocycleId ?? 'none'}
    </div>
  ),
}));

import { fetchLiftCatalog, fetchWorkout } from '@/lib/api';
import LiftPickerPage from './page';

const mockedWorkout = fetchWorkout as unknown as jest.Mock;
const mockedCatalog = fetchLiftCatalog as unknown as jest.Mock;

async function renderPicker(macrocycleNum: string, query: Record<string, string>): Promise<string> {
  const element = (await LiftPickerPage({
    params: Promise.resolve({ macrocycleNum, workoutNum: '1' }),
    searchParams: Promise.resolve(query),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('LiftPickerPage and the macrocycle id (#1198)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCatalog.mockResolvedValue([]);
    mockedWorkout.mockResolvedValue({ macrocycleNum: 1, macrocycleId: 'mc-a', week: 1, lifts: [] });
  });

  it('sends the id Manage Lifts linked with, without reading the workout', async () => {
    expect(await renderPicker('1', { action: 'add', macrocycleId: 'mc-linked' })).toContain('lift-picker:1:mc-linked');
    expect(mockedWorkout).not.toHaveBeenCalled();
  });

  it('reads the workout for the id when the link has none', async () => {
    expect(await renderPicker('1', { action: 'add' })).toContain('lift-picker:1:mc-a');
    expect(mockedWorkout).toHaveBeenCalledWith('5-3-1', 1);
  });

  it('redirects a link with no id and an old number to the current one, keeping its query and adding the id', async () => {
    await expect(renderPicker('7', { action: 'replace', replacing: 'Dips' })).rejects.toThrow(
      'REDIRECT:/macrocycle/1/workout/1/detail/manage-lifts/pick?action=replace&replacing=Dips&macrocycleId=mc-a',
    );
  });
});
