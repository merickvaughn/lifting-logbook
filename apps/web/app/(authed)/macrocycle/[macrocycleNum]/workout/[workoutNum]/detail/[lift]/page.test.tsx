import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchTrainingMaxes: jest.fn().mockResolvedValue([]),
  fetchTrainingMaxHistory: jest.fn().mockResolvedValue({ entries: [] }),
  fetchLiftRecords: jest.fn().mockResolvedValue([]),
  fetchCustomLifts: jest.fn(),
}));

jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('5-3-1'),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

jest.mock('./LiftHistoryFilters', () => ({
  __esModule: true,
  default: ({ records }: { records: { date: string }[] }) => (
    <div>history-filters:{records.map((r) => r.date).join(',')}</div>
  ),
}));

import {
  fetchCustomLifts,
  fetchLiftRecords,
  fetchTrainingMaxes,
  fetchTrainingMaxHistory,
} from '@/lib/api';
import LiftDetailPage from './page';

const mockedCustomLifts = fetchCustomLifts as unknown as jest.Mock;
const mockedMaxes = fetchTrainingMaxes as unknown as jest.Mock;
const mockedHistory = fetchTrainingMaxHistory as unknown as jest.Mock;
const mockedRecords = fetchLiftRecords as unknown as jest.Mock;

async function renderLift(lift: string): Promise<string> {
  const element = (await LiftDetailPage({
    params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1', lift: encodeURIComponent(lift) }),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

describe('LiftDetailPage — rows stored under another spelling (#1118)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCustomLifts.mockResolvedValue([]);
  });

  afterEach(() => {
    mockedMaxes.mockResolvedValue([]);
    mockedHistory.mockResolvedValue({ entries: [] });
    mockedRecords.mockResolvedValue([]);
  });

  const record = (lift: string, date: string) => ({ id: date, lift, date, setNum: 1, weight: 180, reps: 8, notes: '' });

  it('lists imported maxes and sets stored by id under the program’s name', async () => {
    mockedMaxes.mockResolvedValue([{ lift: 'bench-press', weight: 200, unit: 'lbs', dateUpdated: '2025-12-29' }]);
    mockedHistory.mockResolvedValue({
      entries: [{ id: 'h1', lift: 'bench-press', weight: 190, unit: 'lbs', date: '2025-06-01', isPR: false }],
    });
    mockedRecords.mockResolvedValue([
      record('bench-press', '2026-01-05'),
      record('Bench Press', '2026-01-12'),
      record('Squat', '2026-01-13'),
    ]);

    const html = await renderLift('Bench Press');

    expect(html).toContain('200');
    expect(html).not.toContain('No training max set.');
    expect(html).toContain('2025-06-01');
    // Both spellings of the lift, newest first, and nothing from another lift.
    expect(html).toContain('history-filters:2026-01-12,2026-01-05');
  });

  it('shows the same rows when opened by the stored id', async () => {
    mockedRecords.mockResolvedValue([record('Bench Press', '2026-01-12')]);

    expect(await renderLift('bench-press')).toContain('history-filters:2026-01-12');
  });

  it('keeps a substitute’s sets off the page of the lift it replaces', async () => {
    mockedRecords.mockResolvedValue([record('Deadlift', '2026-01-12'), record('Romanian Deadlift', '2026-01-13')]);

    expect(await renderLift('Deadlift')).toContain('history-filters:2026-01-12<');
  });
});

describe('LiftDetailPage — a lift with nothing logged yet (#1060)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCustomLifts.mockResolvedValue([{ name: 'Cable Y-Raise', id: 'c-1' }]);
  });

  it('shows a catalog lift, such as a focus lift, with an empty history', async () => {
    const html = await renderLift('Lateral Raise');

    expect(html).toContain('Lateral Raise');
    expect(html).toContain('No sets logged yet.');
    // A catalog lift is settled without the custom-lift fetch.
    expect(mockedCustomLifts).not.toHaveBeenCalled();
  });

  it('shows one of the lifter’s custom lifts with an empty history', async () => {
    const html = await renderLift('Cable Y-Raise');

    expect(html).toContain('Cable Y-Raise');
    expect(html).toContain('No sets logged yet.');
  });

  it('is not found for a lift nobody knows', async () => {
    await expect(renderLift('Nonexistent Lift')).rejects.toThrow('NOT_FOUND');
  });

  it('is not found, and says why, when the custom-lift fetch fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockedCustomLifts.mockRejectedValue(new Error('API down'));

    await expect(renderLift('Cable Y-Raise')).rejects.toThrow('NOT_FOUND');
    expect(errSpy).toHaveBeenCalledWith(
      '[LiftDetailPage] custom lifts fetch failed, treating the lift as unknown',
      expect.any(Error),
    );
    errSpy.mockRestore();
  });
});
