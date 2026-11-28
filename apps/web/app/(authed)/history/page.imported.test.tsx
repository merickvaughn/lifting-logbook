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
  fetchRecordedPrograms: jest.fn().mockResolvedValue([]),
  fetchUserSettings: jest.fn().mockResolvedValue({ activeProgram: '5-3-1' }),
  fetchCustomLifts: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/preferences', () => ({ getPreferredUnit: jest.fn().mockResolvedValue('lbs') }));
jest.mock('@/lib/client-api', () => ({ undoImport: jest.fn() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

import { fetchCustomLifts, fetchLiftRecords } from '@/lib/api';
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
function liftFilterOptions(html: string): string[] {
  const select = html.match(/aria-label="Filter by lift">(.*?)<\/select>/)?.[1] ?? '';
  return [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
}

function liftColumn(html: string): string[] {
  const body = html.match(/<tbody>(.*?)<\/tbody>/)?.[1] ?? '';
  return [...body.matchAll(/<tr>(?:<td>[^<]*<\/td>)(<td>[^<]*<\/td>)/g)].map((m) => m[1].slice(4, -5));
}

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
    expect(liftFilterOptions(html)).toEqual([
      'All Lifts',
      'Bench Press',
      'Squat',
    ]);
  });
});

// #1503: import stores a built-in lift by catalog id and a custom lift by its id, and the lifter
// should see names in the Lift column as well as the filter.
describe('HistoryPage with sets stored by lift id', () => {
  const ZERCHER = '0f8e2b1c-5d4a-4e7b-9c3f-2a1b6d8e9f00';

  beforeEach(() => {
    (fetchLiftRecords as jest.Mock).mockResolvedValue([
      imported('a', 1, 'barbell-row', '2021-03-02'),
      imported('b', 1, ZERCHER, '2021-03-01'),
    ]);
  });

  it('shows the catalog name and the custom lift name in the Lift column and the filter', async () => {
    (fetchCustomLifts as jest.Mock).mockResolvedValue([{ id: ZERCHER, name: 'Zercher Squat' }]);

    const html = renderToStaticMarkup((await HistoryPage({ searchParams: Promise.resolve({}) })) as ReactElement);

    expect(liftColumn(html)).toEqual(['Barbell Row', 'Zercher Squat']);
    expect(liftFilterOptions(html)).toEqual(['All Lifts', 'Barbell Row', 'Zercher Squat']);
    expect(html).not.toContain(ZERCHER);
  });

  it('shows the load notice and still lists the sets when custom lifts can’t be fetched', async () => {
    (fetchCustomLifts as jest.Mock).mockRejectedValue(new Error('API unavailable'));

    const html = renderToStaticMarkup((await HistoryPage({ searchParams: Promise.resolve({}) })) as ReactElement);

    expect(html).toContain('role="status"');
    expect(liftColumn(html)).toEqual(['Barbell Row', ZERCHER]);
  });
});
