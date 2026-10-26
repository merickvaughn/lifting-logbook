import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

jest.mock('@/lib/api', () => ({
  fetchMacrocycleDashboard: jest.fn(),
  fetchProgramSpec: jest.fn(),
}));
jest.mock('@/lib/active-program', () => ({ getActiveProgram: jest.fn() }));
jest.mock('@/lib/preferences', () => ({ getPreferredUnit: jest.fn() }));

// Stub the client component and echo its props, so the test sees exactly what the page
// passes down (the ImportPage test's pattern).
jest.mock('./FocusCalendar', () => ({
  __esModule: true,
  default: ({ phases, unit }: { phases: unknown[]; unit: unknown }) => (
    <div data-phases={JSON.stringify(phases)} data-unit={JSON.stringify(unit)}>
      focus-calendar
    </div>
  ),
}));

import { fetchMacrocycleDashboard, fetchProgramSpec } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import CalendarPage from './page';

const mockDashboard = fetchMacrocycleDashboard as unknown as jest.Mock;
const mockSpec = fetchProgramSpec as unknown as jest.Mock;
const mockProgram = getActiveProgram as unknown as jest.Mock;
const mockUnit = getPreferredUnit as unknown as jest.Mock;

// One workout a week, as the Playwright mock's 5-3-1 spec gives.
const SPEC = [
  { week: 1, lift: 'squat', order: 1, offset: 0, increment: 5, sets: 3, reps: 5, amrap: true, warmUpPct: '0.4', wtDecrementPct: 0, activation: 'none' },
];

async function renderedProps(): Promise<{ phases: { name: string; start: string; end: string; weeks: number }[]; unit: string }> {
  const html = renderToStaticMarkup((await CalendarPage()) as ReactElement);
  const attr = (name: string) => {
    const match = new RegExp(`${name}="([^"]*)"`).exec(html);
    return JSON.parse((match?.[1] ?? 'null').replace(/&quot;/g, '"'));
  };
  return { phases: attr('data-phases'), unit: attr('data-unit') };
}

describe('CalendarPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProgram.mockResolvedValue('5-3-1');
    mockSpec.mockResolvedValue(SPEC);
    mockUnit.mockResolvedValue('kg');
  });

  it('passes no phases when there is no current macrocycle', async () => {
    mockDashboard.mockResolvedValue(null);
    expect(await renderedProps()).toEqual({ phases: [], unit: 'kg' });
  });

  it('dates each mesocycle from its workouts, following a rescheduled one', async () => {
    mockDashboard.mockResolvedValue({
      program: '5-3-1',
      macrocycleNum: 1,
      macrocycleStartDate: '2025-01-06',
      weeks: [],
      dateOverrides: { 3: '2025-01-23' },
      skippedWorkoutNums: [],
      completedWorkoutNums: [],
    });
    const { phases } = await renderedProps();
    // 5-3-1: twelve weeks in four three-week mesocycles.
    expect(phases.map((p) => p.name)).toEqual(['Mesocycle 1', 'Mesocycle 2', 'Mesocycle 3', 'Mesocycle 4']);
    expect(phases[0]).toEqual({ name: 'Mesocycle 1', type: 'training', start: '2025-01-06', end: '2025-01-23', weeks: 3 });
    expect(phases[3]).toMatchObject({ start: '2025-03-10', end: '2025-03-24' });
  });
});
