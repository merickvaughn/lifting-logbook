import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MacrocycleSummaryResponse, TrainingMaxHistoryEntryResponse } from '@lifting-logbook/types';
import HistoryTabs from './HistoryTabs';
import type { EnrichedRecord } from './page';

const RECORD: EnrichedRecord = {
  id: 'rec-1',
  program: '5-3-1',
  macrocycleNum: 1,
  workoutNum: 1,
  date: '2026-06-01',
  lift: 'Back Squat',
  setNum: 1,
  weight: 225,
  reps: 5,
  notes: '',
  tmAtTime: 315,
  tmUnit: 'lbs',
  tmPercent: 71.4,
  isPR: false,
};

const TM_ENTRY: TrainingMaxHistoryEntryResponse = {
  id: 'tm-1',
  lift: 'Back Squat',
  weight: 315,
  unit: 'lbs',
  date: '2026-06-01',
  isPR: false,
  source: 'program',
  goalMet: false,
};

describe('HistoryTabs — unit conversion', () => {
  it('renders lift-history weight and TM-at-time converted to the preferred unit', () => {
    render(<HistoryTabs records={[RECORD]} tmEntries={[TM_ENTRY]} macrocycles={[]} unit="kg" />);

    // 225 lbs -> 102.06 kg, 315 lbs -> 142.88 kg (see packages/core weightUnit.test.ts).
    expect(screen.getByText(/102\.06 kg × 5/)).toBeInTheDocument();
    expect(screen.getByText('142.88 kg')).toBeInTheDocument();
  });

  it('renders the raw value unconverted when the preferred unit is lbs', () => {
    render(<HistoryTabs records={[RECORD]} tmEntries={[TM_ENTRY]} macrocycles={[]} unit="lbs" />);

    expect(screen.getByText(/225 lbs × 5/)).toBeInTheDocument();
    expect(screen.getByText('315 lbs')).toBeInTheDocument();
  });

  it('renders TM Timeline entries converted to the preferred unit', async () => {
    const user = userEvent.setup();
    render(<HistoryTabs records={[RECORD]} tmEntries={[TM_ENTRY]} macrocycles={[]} unit="kg" />);

    await user.click(screen.getByRole('tab', { name: 'TM Timeline' }));
    expect(screen.getByText('142.88 kg')).toBeInTheDocument();
  });
});

// #1197: past macrocycles, newest first, with their dates, status and source.
describe('HistoryTabs — Macrocycles', () => {
  const macrocycle = (overrides: Partial<MacrocycleSummaryResponse>): MacrocycleSummaryResponse => ({
    id: 'm',
    macrocycleNum: 1,
    startDate: '2026-01-05',
    endDate: null,
    status: 'in-progress',
    origin: 'live',
    current: false,
    unmatched: false,
    ...overrides,
  });

  it('lists each macrocycle newest first with its dates, status and source', async () => {
    const user = userEvent.setup();
    render(
      <HistoryTabs
        records={[]}
        tmEntries={[]}
        macrocycles={[
          macrocycle({ id: 'a', macrocycleNum: 1, endDate: '2026-02-01', status: 'completed', origin: 'imported' }),
          macrocycle({ id: 'b', macrocycleNum: 2, startDate: '2026-02-09', endDate: '2026-02-20', status: 'unknown', origin: 'legacy' }),
          macrocycle({ id: 'c', macrocycleNum: 3, startDate: '2026-03-02', current: true }),
        ]}
        unit="lbs"
      />,
    );

    await user.click(screen.getByRole('tab', { name: 'Macrocycles' }));
    const rows = screen.getAllByRole('row').slice(1).map((row) => row.textContent);
    expect(rows).toEqual([
      '3 (current)2026-03-02—In progressLogged here',
      '22026-02-092026-02-20Status unknownEarlier records',
      '12026-01-052026-02-01CompletedImported',
    ]);
  });

  it('says so when there are none', async () => {
    const user = userEvent.setup();
    render(<HistoryTabs records={[]} tmEntries={[]} macrocycles={[]} unit="lbs" />);
    await user.click(screen.getByRole('tab', { name: 'Macrocycles' }));
    expect(screen.getByText('No macrocycles yet.')).toBeInTheDocument();
  });
});
