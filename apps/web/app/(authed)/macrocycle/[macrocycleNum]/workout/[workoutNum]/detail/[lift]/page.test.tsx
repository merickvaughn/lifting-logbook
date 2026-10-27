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

jest.mock('./LiftHistoryFilters', () => ({ __esModule: true, default: () => <div>history-filters</div> }));

import { fetchCustomLifts } from '@/lib/api';
import LiftDetailPage from './page';

const mockedCustomLifts = fetchCustomLifts as unknown as jest.Mock;

async function renderLift(lift: string): Promise<string> {
  const element = (await LiftDetailPage({
    params: Promise.resolve({ macrocycleNum: '1', workoutNum: '1', lift: encodeURIComponent(lift) }),
  })) as ReactElement;
  return renderToStaticMarkup(element);
}

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
