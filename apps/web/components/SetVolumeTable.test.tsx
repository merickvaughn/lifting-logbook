import { render, screen, within } from '@testing-library/react';
import { collapseIdenticalWeeks, type WeeklyVolume } from '@lifting-logbook/core';
import SetVolumeTable, { weekColumns } from './SetVolumeTable';

const week = (n: number, counts: [string, number][], uncounted: [string, number][] = []): WeeklyVolume => ({
  week: n,
  counts: counts.map(([key, sets]) => ({ key, sets })),
  uncounted: uncounted.map(([lift, sets]) => ({ lift, sets })),
});

// Each row's header and cells, as a screen reader would read them across.
const rows = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .map((row) => Array.from(row.querySelectorAll('th, td'), (cell) => cell.textContent));

describe('SetVolumeTable (#1017)', () => {
  it('renders a captioned table with scoped headers, ordered and joined by toVolumeTable', () => {
    render(
      <SetVolumeTable
        caption="Weekly working sets"
        rowHeader="Muscle"
        order="muscle"
        columns={[
          { label: 'Planned', volume: week(1, [['Triceps', 1.5], ['Chest', 3]]) },
          { label: 'Done', volume: week(1, [['chest', 2]]) },
        ]}
      />,
    );
    const table = screen.getByRole('table', { name: 'Weekly working sets' });
    expect(rows(table)).toEqual([
      ['Muscle', 'Planned', 'Done'],
      // Heaviest first; "chest" joins "Chest", and a column without Triceps reads 0.
      ['Chest', '3', '2'],
      ['Triceps', '1.5', '0'],
    ]);
    expect(screen.getByRole('columnheader', { name: 'Planned' })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('rowheader', { name: 'Chest' })).toHaveAttribute('scope', 'row');
  });

  it('lists lifts no row counts under "Not counted"', () => {
    render(
      <SetVolumeTable
        caption="Weekly working sets"
        rowHeader="Muscle"
        order="muscle"
        columns={[{ label: 'Sets / week', volume: week(1, [['Chest', 3]], [['Zercher Carry', 2.5]]) }]}
      />,
    );
    const footer = screen.getByRole('columnheader', { name: 'Not counted' }).closest('tfoot');
    expect(footer).not.toBeNull();
    expect(screen.getByRole('rowheader', { name: 'Zercher Carry' }).closest('tfoot')).toBe(footer);
    expect(rows(screen.getByRole('table')).at(-1)).toEqual(['Zercher Carry', '2.5']);
  });

  it('orders pattern rows in the fixed pattern order', () => {
    render(
      <SetVolumeTable
        caption="Sets by pattern"
        rowHeader="Pattern"
        order="pattern"
        columns={[{ label: 'Sets / week', volume: week(1, [['Isolation / other', 9], ['Squat', 3], ['Horizontal Push', 6]]) }]}
      />,
    );
    expect(rows(screen.getByRole('table')).slice(1).map((r) => r[0])).toEqual([
      'Horizontal Push',
      'Squat',
      'Isolation / other',
    ]);
  });

  it('says so when there are no sets, instead of an empty table', () => {
    render(
      <SetVolumeTable caption="Weekly working sets" rowHeader="Muscle" order="muscle" columns={[{ label: 'Done', volume: week(1, []) }]} />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('Weekly working sets: no working sets.')).toBeInTheDocument();
  });
});

describe('weekColumns', () => {
  it('labels a single merged column "Sets / week"', () => {
    const columns = collapseIdenticalWeeks([week(1, [['Chest', 3]]), week(2, [['Chest', 3]])]);
    expect(weekColumns(columns).map((c) => c.label)).toEqual(['Sets / week']);
  });

  it('labels merged weeks with their list, never a range', () => {
    const columns = collapseIdenticalWeeks([
      week(1, [['Chest', 3]]),
      week(2, [['Chest', 4]]),
      week(3, [['Chest', 3]]),
    ]);
    expect(weekColumns(columns).map((c) => c.label)).toEqual(['Weeks 1, 3', 'Week 2']);
  });
});
