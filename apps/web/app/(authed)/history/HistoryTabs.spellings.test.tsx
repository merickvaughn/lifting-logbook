import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrainingMaxHistoryEntryResponse } from '@lifting-logbook/types';
import HistoryTabs from './HistoryTabs';
import type { EnrichedRecord } from './page';

const record = (id: string, lift: string, weight: number): EnrichedRecord => ({
  id,
  program: '5-3-1',
  macrocycleNum: 1,
  workoutNum: 1,
  date: '2026-06-01',
  lift,
  setNum: 1,
  weight,
  reps: 5,
  notes: '',
  tmAtTime: null,
  tmUnit: null,
  tmPercent: null,
  isPR: false,
});

const tmEntry = (id: string, lift: string, weight: number): TrainingMaxHistoryEntryResponse => ({
  id,
  lift,
  weight,
  unit: 'lbs',
  date: '2026-06-01',
  isPR: false,
  source: 'program',
  goalMet: false,
});

function liftOptions(): string[] {
  return within(screen.getByRole('combobox', { name: /lift/i }))
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
}

// #1135: rows stored under a catalog id are the same lift as rows under its name.
describe('HistoryTabs across stored spellings', () => {
  it('lists Bench Press once, and filters to its bench-press rows too', async () => {
    const user = userEvent.setup();
    render(
      <HistoryTabs
        records={[record('a', 'Bench Press', 200), record('b', 'bench-press', 210), record('c', 'Back Squat', 300)]}
        tmEntries={[]}
        unit="lbs"
      />,
    );

    expect(liftOptions().filter((option) => /bench/i.test(option))).toEqual(['Bench Press']);

    await user.selectOptions(screen.getByRole('combobox', { name: /lift/i }), 'Bench Press');
    expect(screen.getByText(/200 lbs × 5/)).toBeInTheDocument();
    expect(screen.getByText(/210 lbs × 5/)).toBeInTheDocument();
    expect(screen.queryByText(/300 lbs × 5/)).not.toBeInTheDocument();
  });

  it('keeps two names for one lift as two options', () => {
    render(
      <HistoryTabs
        records={[record('a', 'C. Lat Raise', 20), record('b', 'Lateral Raise', 40)]}
        tmEntries={[]}
        unit="lbs"
      />,
    );
    expect(liftOptions()).toEqual(expect.arrayContaining(['C. Lat Raise', 'Lateral Raise']));
  });

  it('groups bench-press timeline entries under Bench Press', async () => {
    const user = userEvent.setup();
    render(
      <HistoryTabs
        records={[]}
        tmEntries={[tmEntry('a', 'Bench Press', 200), tmEntry('b', 'bench-press', 210)]}
        unit="lbs"
      />,
    );

    await user.click(screen.getByRole('tab', { name: 'TM Timeline' }));
    expect(liftOptions().filter((option) => /bench/i.test(option))).toEqual(['Bench Press']);
    expect(screen.queryByRole('heading', { name: 'bench-press' })).not.toBeInTheDocument();
    expect(screen.getByText('200 lbs')).toBeInTheDocument();
    expect(screen.getByText('210 lbs')).toBeInTheDocument();
  });
});
