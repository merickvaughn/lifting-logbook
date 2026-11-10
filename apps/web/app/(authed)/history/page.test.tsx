import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EnrichedRecord } from './page';

jest.mock('@/lib/api', () => ({
  fetchLiftRecords: jest.fn(),
  fetchTrainingMaxHistory: jest.fn(),
  fetchMacrocycles: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
}));
jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));
jest.mock('./HistoryTabs', () => ({
  __esModule: true,
  default: ({ records, macrocycles }: { records: unknown; macrocycles: unknown }) => (
    <div data-records={JSON.stringify(records)} data-macrocycles={JSON.stringify(macrocycles)} />
  ),
}));

import { fetchLiftRecords, fetchMacrocycles, fetchTrainingMaxHistory } from '@/lib/api';
import HistoryPage from './page';

const record = (id: string, lift: string, date: string, weight: number) => ({
  id,
  program: '5-3-1',
  macrocycleNum: 1,
  workoutNum: 1,
  date,
  lift,
  setNum: 1,
  weight,
  reps: 5,
  notes: '',
});

async function renderRecords(): Promise<EnrichedRecord[]> {
  const html = renderToStaticMarkup((await HistoryPage()) as ReactElement);
  const encoded = html.match(/data-records="([^"]*)"/)?.[1];
  if (encoded === undefined) throw new Error('data-records attribute not found in rendered output');
  return JSON.parse(encoded.replace(/&quot;/g, '"')) as EnrichedRecord[];
}

// #1135: a record stored by catalog id is the same lift as one under its name.
describe('HistoryPage across stored spellings', () => {
  it('shares one PR between Bench Press and bench-press, and reads a bench-press training max', async () => {
    (fetchLiftRecords as jest.Mock).mockResolvedValue([
      record('name-row', 'Bench Press', '2026-02-01', 200),
      record('id-row', 'bench-press', '2026-03-01', 180),
    ]);
    (fetchTrainingMaxHistory as jest.Mock).mockResolvedValue({
      entries: [
        { id: 't', lift: 'bench-press', weight: 250, unit: 'lbs', date: '2026-01-01', isPR: false, source: 'program', goalMet: false },
      ],
    });

    const records = await renderRecords();
    const byId = new Map(records.map((r) => [r.id, r]));

    expect(byId.get('name-row')?.isPR).toBe(true);
    expect(byId.get('id-row')?.isPR).toBe(false);
    expect(byId.get('name-row')?.tmAtTime).toBe(250);
  });

  it('keeps a PR apiece for two names a program can plan separately', async () => {
    (fetchLiftRecords as jest.Mock).mockResolvedValue([
      record('cable', 'C. Lat Raise', '2026-02-01', 20),
      record('dumbbell', 'Lateral Raise', '2026-02-01', 40),
    ]);
    (fetchTrainingMaxHistory as jest.Mock).mockResolvedValue({ entries: [] });

    const records = await renderRecords();

    expect(records.every((r) => r.isPR)).toBe(true);
  });
});

// #1197: the Macrocycles tab's list, and the notice when it can't be loaded.
describe('HistoryPage macrocycles', () => {
  const MACROCYCLE = {
    id: 'm-1',
    macrocycleNum: 1,
    startDate: '2026-01-05',
    endDate: '2026-02-01',
    status: 'completed',
    origin: 'imported',
    current: false,
    unmatched: false,
  };

  beforeEach(() => {
    (fetchLiftRecords as jest.Mock).mockResolvedValue([]);
    (fetchTrainingMaxHistory as jest.Mock).mockResolvedValue({ entries: [] });
  });

  it('passes the program\'s macrocycles to the tabs, with no notice', async () => {
    (fetchMacrocycles as jest.Mock).mockResolvedValue([MACROCYCLE]);
    const html = renderToStaticMarkup((await HistoryPage()) as ReactElement);
    expect(fetchMacrocycles).toHaveBeenCalledWith('5-3-1');
    const encoded = html.match(/data-macrocycles="([^"]*)"/)?.[1] ?? '';
    expect(JSON.parse(encoded.replace(/&quot;/g, '"'))).toEqual([MACROCYCLE]);
    expect(html).not.toContain('role="status"');
  });

  it('shows the load notice when the macrocycles can\'t be fetched', async () => {
    (fetchMacrocycles as jest.Mock).mockRejectedValue(new Error('API unavailable'));
    const html = renderToStaticMarkup((await HistoryPage()) as ReactElement);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-macrocycles="[]"');
  });
});
