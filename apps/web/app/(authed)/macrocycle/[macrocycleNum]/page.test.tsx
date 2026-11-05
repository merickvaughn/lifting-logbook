import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { WeekRow } from '@/lib/workoutPlan';

jest.mock('@/lib/api', () => ({
  fetchMacrocycleDashboard: jest.fn(),
  fetchProgramSpec: jest.fn(),
  fetchTrainingMaxes: jest.fn(),
}));

jest.mock('@/lib/active-program', () => ({
  getActiveProgram: jest.fn().mockResolvedValue('p'),
}));

jest.mock('@/lib/preferences', () => ({
  getPreferredUnit: jest.fn().mockResolvedValue('lbs'),
}));

jest.mock('@/lib/userToday', () => ({
  getUserToday: jest.fn().mockResolvedValue('2026-01-05'),
}));

jest.mock('next/navigation', () => ({
  notFound: jest.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));

jest.mock('./MacrocycleDashboardGrid', () => ({
  __esModule: true,
  default: ({ weeks }: { weeks: WeekRow[] }) => <div data-weeks={JSON.stringify(weeks)} />,
}));

import { fetchMacrocycleDashboard, fetchProgramSpec, fetchTrainingMaxes } from '@/lib/api';
import MacrocycleDashboardPage from './page';

describe('MacrocycleDashboardPage (#1118)', () => {
  it('plans a lift from a max stored by catalog id, as import stores it', async () => {
    (fetchMacrocycleDashboard as unknown as jest.Mock).mockResolvedValue({
      program: 'p',
      macrocycleNum: 1,
      macrocycleStartDate: '2026-01-05',
      weeks: [],
    });
    (fetchProgramSpec as unknown as jest.Mock).mockResolvedValue([
      {
        week: 1,
        offset: 0,
        lift: 'Bench Press',
        order: 1,
        increment: 5,
        sets: 1,
        reps: 5,
        amrap: false,
        warmUpPct: '',
        wtDecrementPct: 0,
        activation: '',
      },
    ]);
    (fetchTrainingMaxes as unknown as jest.Mock).mockResolvedValue([
      { lift: 'bench-press', weight: 200, unit: 'lbs', dateUpdated: '2025-12-29' },
    ]);

    const element = (await MacrocycleDashboardPage({
      params: Promise.resolve({ macrocycleNum: '1' }),
    })) as ReactElement;
    const encoded = renderToStaticMarkup(element).match(/data-weeks="([^"]*)"/)?.[1];
    if (encoded === undefined) throw new Error('data-weeks attribute not found');
    const weeks = JSON.parse(encoded.replace(/&quot;/g, '"')) as WeekRow[];

    const bench = weeks[0]?.workouts[0]?.lifts[0];
    expect(bench?.name).toBe('Bench Press');
    expect(bench?.sets.filter((s) => s.type === 'work').map((s) => s.weight)).toEqual([200]);
  });
});
