import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TrainingMaxHistoryEntryResponse } from '@lifting-logbook/types';
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
    render(<HistoryTabs records={[RECORD]} tmEntries={[TM_ENTRY]} unit="kg" />);

    // 225 lbs -> 102.06 kg, 315 lbs -> 142.88 kg (see packages/core weightUnit.test.ts).
    expect(screen.getByText(/102\.06 kg × 5/)).toBeInTheDocument();
    expect(screen.getByText('142.88 kg')).toBeInTheDocument();
  });

  it('renders the raw value unconverted when the preferred unit is lbs', () => {
    render(<HistoryTabs records={[RECORD]} tmEntries={[TM_ENTRY]} unit="lbs" />);

    expect(screen.getByText(/225 lbs × 5/)).toBeInTheDocument();
    expect(screen.getByText('315 lbs')).toBeInTheDocument();
  });

  it('renders TM Timeline entries converted to the preferred unit', async () => {
    const user = userEvent.setup();
    render(<HistoryTabs records={[RECORD]} tmEntries={[TM_ENTRY]} unit="kg" />);

    await user.click(screen.getByRole('tab', { name: 'TM Timeline' }));
    expect(screen.getByText('142.88 kg')).toBeInTheDocument();
  });
});
