import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EnrichedRecord } from './page';

jest.mock('@/lib/api', () => ({
  fetchLiftRecords: jest.fn(),
  fetchTrainingMaxHistory: jest.fn(),
  fetchMacrocycles: jest.fn().mockResolvedValue([]),
  fetchNonCycleRecords: jest.fn().mockResolvedValue([]),
  fetchImportBatches: jest.fn().mockResolvedValue([]),
  fetchCustomPrograms: jest.fn().mockResolvedValue([]),
  // Read through the real lib/active-program, so these tests hold whichever of its reads the page uses.
  fetchUserSettings: jest.fn().mockResolvedValue({ activeProgram: '5-3-1' }),
}));
jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));
jest.mock('./HistoryTabs', () => ({
  __esModule: true,
  default: ({ records, macrocycles, imports }: { records: unknown; macrocycles: unknown; imports: unknown }) => (
    <div
      data-records={JSON.stringify(records)}
      data-macrocycles={JSON.stringify(macrocycles)}
      data-imports={JSON.stringify(imports)}
    />
  ),
}));

import {
  fetchCustomPrograms,
  fetchImportBatches,
  fetchLiftRecords,
  fetchMacrocycles,
  fetchNonCycleRecords,
  fetchTrainingMaxHistory,
  fetchUserSettings,
} from '@/lib/api';
import HistoryPage from './page';

const historyPage = (params: { program?: string } = {}) => HistoryPage({ searchParams: Promise.resolve(params) });

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
  const html = renderToStaticMarkup((await historyPage()) as ReactElement);
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

// #1184: non-cycle workouts are listed whichever program is active, with no training max.
describe('HistoryPage non-cycle workouts', () => {
  const nonCycle = { ...record('nc', 'Squat', '2026-03-01', 405), program: 'non-cycle', workoutNum: 4 };

  beforeEach(() => {
    (fetchMacrocycles as jest.Mock).mockResolvedValue([]);
    (fetchLiftRecords as jest.Mock).mockResolvedValue([record('program-row', 'Squat', '2026-02-01', 315)]);
    // The active program has a Squat max that covers the non-cycle set's date.
    (fetchTrainingMaxHistory as jest.Mock).mockResolvedValue({
      entries: [
        { id: 't', lift: 'Squat', weight: 350, unit: 'lbs', date: '2026-01-01', isPR: false, source: 'program', goalMet: false },
      ],
    });
  });

  it('lists one beside the program’s records, counts it for PRs, and shows no TM or %', async () => {
    (fetchNonCycleRecords as jest.Mock).mockResolvedValue([nonCycle]);
    const byId = new Map((await renderRecords()).map((r) => [r.id, r]));

    expect(byId.get('nc')).toMatchObject({ program: 'non-cycle', tmAtTime: null, tmUnit: null, tmPercent: null, isPR: true });
    expect(byId.get('program-row')).toMatchObject({ tmAtTime: 350, isPR: false });
  });

  it('shows the load notice when they can’t be fetched, and still lists the program’s records', async () => {
    (fetchNonCycleRecords as jest.Mock).mockRejectedValue(new Error('API unavailable'));
    const html = renderToStaticMarkup((await historyPage()) as ReactElement);
    expect(html).toContain('role="status"');
    expect((await renderRecords()).map((r) => r.id)).toEqual(['program-row']);
  });

  it('links to recording one', async () => {
    (fetchNonCycleRecords as jest.Mock).mockResolvedValue([]);
    const html = renderToStaticMarkup((await historyPage()) as ReactElement);
    expect(html).toContain('href="/non-cycle/new"');
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
    (fetchNonCycleRecords as jest.Mock).mockResolvedValue([]);
    (fetchTrainingMaxHistory as jest.Mock).mockResolvedValue({ entries: [] });
  });

  it('passes the program\'s macrocycles to the tabs, with no notice', async () => {
    (fetchMacrocycles as jest.Mock).mockResolvedValue([MACROCYCLE]);
    const html = renderToStaticMarkup((await historyPage()) as ReactElement);
    expect(fetchMacrocycles).toHaveBeenCalledWith('5-3-1');
    const encoded = html.match(/data-macrocycles="([^"]*)"/)?.[1] ?? '';
    expect(JSON.parse(encoded.replace(/&quot;/g, '"'))).toEqual([MACROCYCLE]);
    expect(html).not.toContain('role="status"');
  });

  it('shows the load notice when the macrocycles can\'t be fetched', async () => {
    (fetchMacrocycles as jest.Mock).mockRejectedValue(new Error('API unavailable'));
    const html = renderToStaticMarkup((await historyPage()) as ReactElement);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-macrocycles="[]"');
  });
});

// #1257: the imports Undo is offered for, and the notice when they can't be loaded.
describe('HistoryPage imports', () => {
  const BATCH = { id: 'b-1', program: '5-3-1', createdAt: '2026-11-01T12:00:00.000Z', macrocycleIds: ['m-1'] };

  beforeEach(() => {
    (fetchLiftRecords as jest.Mock).mockResolvedValue([]);
    (fetchNonCycleRecords as jest.Mock).mockResolvedValue([]);
    (fetchTrainingMaxHistory as jest.Mock).mockResolvedValue({ entries: [] });
    (fetchMacrocycles as jest.Mock).mockResolvedValue([]);
  });

  it('passes the program\'s imports to the tabs, with no notice', async () => {
    (fetchImportBatches as jest.Mock).mockResolvedValue([BATCH]);
    const html = renderToStaticMarkup((await historyPage()) as ReactElement);
    expect(fetchImportBatches).toHaveBeenCalledWith('5-3-1');
    const encoded = html.match(/data-imports="([^"]*)"/)?.[1] ?? '';
    expect(JSON.parse(encoded.replace(/&quot;/g, '"'))).toEqual([BATCH]);
    expect(html).not.toContain('role="status"');
  });

  it('says only that Undo is unavailable, and offers none, when they can\'t be fetched', async () => {
    (fetchImportBatches as jest.Mock).mockRejectedValue(new Error('API unavailable'));
    const html = renderToStaticMarkup((await historyPage()) as ReactElement);
    expect(html).toContain('Undoing an import isn’t available right now.');
    // The history itself loaded, so its notice isn't shown.
    expect(html).not.toContain('latest history');
    expect(html).toContain('data-imports="[]"');
  });
});

// #1300: an import can go into any of the lifter's programs, and History can show each of them.
describe('HistoryPage program', () => {
  const CUSTOM = {
    id: '0b5c1f3e-8a2d-4c6b-9e7f-1a2b3c4d5e6f',
    name: 'Sheets import',
    description: null,
    baseTemplate: null,
    createdAt: '2026-11-13',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Like the API: a program the account doesn't have is a 404.
    (fetchLiftRecords as jest.Mock).mockImplementation(async (program: string) => {
      if (program !== CUSTOM.id && program !== '5-3-1') throw new Error('404');
      return [];
    });
    (fetchNonCycleRecords as jest.Mock).mockResolvedValue([]);
    (fetchTrainingMaxHistory as jest.Mock).mockResolvedValue({ entries: [] });
    (fetchMacrocycles as jest.Mock).mockResolvedValue([]);
    (fetchImportBatches as jest.Mock).mockResolvedValue([]);
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([CUSTOM]);
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '5-3-1' });
  });

  it('shows the lifter’s only program, with no notice, when none is active', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: null });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([CUSTOM]);

    const html = renderToStaticMarkup((await historyPage()) as ReactElement);

    expect(fetchLiftRecords).toHaveBeenCalledWith(CUSTOM.id);
    expect(fetchMacrocycles).toHaveBeenCalledWith(CUSTOM.id);
    expect(fetchImportBatches).toHaveBeenCalledWith(CUSTOM.id);
    expect(html).not.toContain('role="status"');
    // One program, so there's nothing to choose.
    expect(html).not.toContain('id="history-program"');
  });

  // The API answers lift-records with no sets for a program with no current macrocycle.
  it('lists an imported-only program’s macrocycles and imports, with no notice', async () => {
    const imported = {
      id: 'm-imported',
      macrocycleNum: 1,
      startDate: '2024-01-01',
      endDate: '2024-01-26',
      status: 'completed',
      origin: 'imported',
      current: false,
      unmatched: false,
    };
    const batch = { id: 'b-imported', program: CUSTOM.id, createdAt: '2026-11-14T12:00:00.000Z', macrocycleIds: ['m-imported'] };
    (fetchMacrocycles as jest.Mock).mockResolvedValue([imported]);
    (fetchImportBatches as jest.Mock).mockResolvedValue([batch]);

    const html = renderToStaticMarkup((await historyPage({ program: CUSTOM.id })) as ReactElement);

    expect(fetchLiftRecords).toHaveBeenCalledWith(CUSTOM.id);
    expect(html).not.toContain('role="status"');
    const attr = (name: string) => JSON.parse((html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '').replace(/&quot;/g, '"'));
    expect(attr('data-macrocycles')).toEqual([imported]);
    expect(attr('data-imports')).toEqual([batch]);
  });

  it('offers no picker when the active program isn’t among the lifter’s programs', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: '9f0e1d2c-3b4a-4596-8a7b-6c5d4e3f2a1b' });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([CUSTOM, { ...CUSTOM, id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', name: 'Other' }]);

    const html = renderToStaticMarkup((await historyPage()) as ReactElement);

    expect(html).not.toContain('id="history-program"');
  });

  it('shows the active program by default, and offers the others', async () => {
    const html = renderToStaticMarkup((await historyPage()) as ReactElement);

    expect(fetchMacrocycles).toHaveBeenCalledWith('5-3-1');
    expect(html).toContain('<label for="history-program">Program</label>');
    expect(html).toContain(`<option value="${CUSTOM.id}">Sheets import</option>`);
    expect(html).toMatch(/<option value="5-3-1" selected="">[^<]* \(active\)<\/option>/);
  });

  it('shows the program asked for when it’s one of the lifter’s', async () => {
    const html = renderToStaticMarkup((await historyPage({ program: CUSTOM.id })) as ReactElement);

    expect(fetchMacrocycles).toHaveBeenCalledWith(CUSTOM.id);
    expect(fetchMacrocycles).not.toHaveBeenCalledWith('5-3-1');
    expect(html).toContain(`<option value="${CUSTOM.id}" selected="">Sheets import</option>`);
  });

  it('shows the active program when the one asked for isn’t the lifter’s', async () => {
    await historyPage({ program: 'someone-elses' });

    expect(fetchMacrocycles).toHaveBeenCalledWith('5-3-1');
    expect(fetchMacrocycles).not.toHaveBeenCalledWith('someone-elses');
  });

  it('loads only non-cycle workouts, with no notice, for an account with no program', async () => {
    (fetchUserSettings as jest.Mock).mockResolvedValue({ activeProgram: null });
    (fetchCustomPrograms as jest.Mock).mockResolvedValue([]);

    const html = renderToStaticMarkup((await historyPage()) as ReactElement);

    expect(fetchLiftRecords).not.toHaveBeenCalled();
    expect(fetchMacrocycles).not.toHaveBeenCalled();
    expect(fetchNonCycleRecords).toHaveBeenCalled();
    expect(html).not.toContain('role="status"');
  });

  it('shows the load notice, and the active program, when the custom programs can’t be fetched', async () => {
    (fetchCustomPrograms as jest.Mock).mockRejectedValue(new Error('API unavailable'));

    const html = renderToStaticMarkup((await historyPage({ program: CUSTOM.id })) as ReactElement);

    expect(fetchMacrocycles).toHaveBeenCalledWith('5-3-1');
    expect(html).toContain('role="status"');
  });

  it('shows the load notice, and the lifter’s first program, when their settings can’t be fetched', async () => {
    (fetchUserSettings as jest.Mock).mockRejectedValue(new Error('API unavailable'));

    const html = renderToStaticMarkup((await historyPage()) as ReactElement);

    expect(fetchMacrocycles).toHaveBeenCalledWith(CUSTOM.id);
    expect(html).toContain('role="status"');
  });
});
