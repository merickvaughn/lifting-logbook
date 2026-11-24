import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The real HistoryTabs, unlike page.test.tsx, so these tests read what the lifter sees.
jest.mock('@/lib/api', () => ({
  fetchLiftRecords: jest.fn(),
  fetchTrainingMaxHistory: jest.fn().mockResolvedValue({ entries: [] }),
  fetchMacrocycles: jest.fn().mockResolvedValue([]),
  fetchNonCycleRecords: jest.fn().mockResolvedValue([]),
  fetchImportBatches: jest.fn().mockResolvedValue([]),
  fetchCustomPrograms: jest.fn().mockResolvedValue([]),
  fetchUserSettings: jest.fn().mockResolvedValue({ activeProgram: '5-3-1' }),
}));
jest.mock('@/lib/preferences', () => ({ getPreferredUnit: jest.fn().mockResolvedValue('lbs') }));
jest.mock('@/lib/client-api', () => ({ undoImport: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

import { fetchLiftRecords } from '@/lib/api';
import HistoryPage from './page';

const imported = (id: string, macrocycleNum: number, lift: string, date: string) => ({
  id,
  program: '5-3-1',
  macrocycleNum,
  workoutNum: 1,
  date,
  lift,
  setNum: 1,
  weight: 225,
  reps: 5,
  notes: '',
});

// #1453: the API now returns every macrocycle's sets, so a program whose current macrocycle
// (35 on staging) holds none still lists its imported ones.
describe('HistoryPage with imported history and an empty current macrocycle', () => {
  it('lists the imported sets, and every imported lift in the lift filter', async () => {
    (fetchLiftRecords as jest.Mock).mockResolvedValue([
      imported('a', 34, 'Squat', '2023-12-26'),
      imported('b', 1, 'Bench Press', '2021-03-01'),
    ]);

    const html = renderToStaticMarkup((await HistoryPage({ searchParams: Promise.resolve({}) })) as ReactElement);

    expect(html).not.toContain('No records match the current filters.');
    expect(html).toContain('2023-12-26');
    expect(html).toContain('Macrocycle 34, Workout 1');
    expect(html).toContain('Macrocycle 1, Workout 1');
    const select = html.match(/aria-label="Filter by lift">(.*?)<\/select>/)?.[1] ?? '';
    expect([...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])).toEqual([
      'All Lifts',
      'Bench Press',
      'Squat',
    ]);
  });
});
