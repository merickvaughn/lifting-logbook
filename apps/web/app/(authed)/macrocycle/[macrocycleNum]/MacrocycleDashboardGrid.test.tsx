import { render, screen } from '@testing-library/react';
import type { WeekRow } from '@/lib/workoutPlan';
import MacrocycleDashboardGrid, { groupWeeksIntoBlocks } from './MacrocycleDashboardGrid';

const weeksOf = (n: number): WeekRow[] =>
  Array.from({ length: n }, (_, i) => ({
    week: i + 1,
    workouts: [
      { workoutNum: i + 1, date: '2099-01-01', status: 'upcoming' as const, lifts: [] },
    ],
  }));

describe('groupWeeksIntoBlocks', () => {
  it('groups 5/3/1 into four 3-week blocks', () => {
    const blocks = groupWeeksIntoBlocks(weeksOf(12), 3);
    expect(blocks?.map((b) => [b.block, b.firstWeek, b.lastWeek])).toEqual([
      [1, 1, 3],
      [2, 4, 6],
      [3, 7, 9],
      [4, 10, 12],
    ]);
  });

  it('does not group one-week blocks (Leangains, RPT)', () => {
    expect(groupWeeksIntoBlocks(weeksOf(12), 1)).toBeNull();
  });

  it('does not group a program that is a single block', () => {
    expect(groupWeeksIntoBlocks(weeksOf(3), 3)).toBeNull();
  });
});

describe('MacrocycleDashboardGrid', () => {
  it('labels the macrocycle and links its glossary entry', () => {
    render(<MacrocycleDashboardGrid macrocycleNum={2} weeks={weeksOf(1)} unit="lbs" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Macrocycle 2' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Macrocycle progress' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'What does “Macrocycle” mean?' })).toHaveAttribute(
      'href',
      '/glossary#macrocycle',
    );
    expect(screen.getByRole('link', { name: /Macrocycle plan/ })).toHaveAttribute(
      'href',
      '/macrocycle/2/plan',
    );
  });

  it('groups weeks under block headings when mesocycles are longer than a week', () => {
    render(
      <MacrocycleDashboardGrid
        macrocycleNum={1}
        weeks={weeksOf(6)}
        unit="lbs"
        mesocycleWeeks={3}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Block 1 · Weeks 1–3' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Block 2 · Weeks 4–6' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'What does “Mesocycle” mean?' })).toHaveLength(2);
    // Week toggles are unchanged inside the blocks.
    expect(screen.getByRole('button', { name: /Week 4/ })).toBeInTheDocument();
  });

  it('keeps a flat week list for one-week blocks', () => {
    render(<MacrocycleDashboardGrid macrocycleNum={1} weeks={weeksOf(3)} unit="lbs" />);
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Week \d/ })).toHaveLength(3);
  });
});
