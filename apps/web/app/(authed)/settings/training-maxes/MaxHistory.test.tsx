import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrainingMaxHistoryEntryResponse } from '@lifting-logbook/types';
import MaxHistory from './MaxHistory';

jest.mock('./actions', () => ({
  toggleHistoryPR: jest.fn(),
  toggleHistoryGoalMet: jest.fn(),
}));

const entry = (id: string, lift: string, weight: number): TrainingMaxHistoryEntryResponse => ({
  id,
  lift,
  weight,
  unit: 'lbs',
  date: '2026-06-01',
  isPR: false,
  source: 'program',
  goalMet: false,
});

const liftFilter = () => screen.getByRole('combobox', { name: 'Filter by lift' });
const options = () => within(liftFilter()).getAllByRole('option').map((option) => option.textContent);

// #1135: an entry stored under a catalog id is the same lift as one under its name.
describe('MaxHistory across stored spellings', () => {
  const renderHistory = (entries: TrainingMaxHistoryEntryResponse[]) =>
    render(<MaxHistory initialEntries={entries} program="5-3-1" unit="lbs" />);

  it('lists Bench Press once, and filters to its bench-press entries too', async () => {
    const user = userEvent.setup();
    renderHistory([entry('a', 'Bench Press', 200), entry('b', 'bench-press', 210), entry('c', 'Deadlift', 300)]);
    expect(options()).toEqual(['All Lifts', 'Bench Press', 'Deadlift']);

    await user.selectOptions(liftFilter(), 'Bench Press');
    expect(screen.getByRole('button', { name: /Mark as PR for Bench Press/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark as PR for bench-press/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark as PR for Deadlift/ })).not.toBeInTheDocument();
  });

  it('keeps two names for one lift as two options', () => {
    renderHistory([entry('a', 'C. Lat Raise', 20), entry('b', 'Lateral Raise', 40)]);
    expect(options()).toEqual(['All Lifts', 'C. Lat Raise', 'Lateral Raise']);
  });
});
