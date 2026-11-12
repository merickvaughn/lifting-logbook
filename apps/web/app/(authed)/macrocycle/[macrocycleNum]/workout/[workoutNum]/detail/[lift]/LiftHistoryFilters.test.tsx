import { render, screen } from '@testing-library/react';
import type { LiftRecordResponse } from '@lifting-logbook/types';
import LiftHistoryFilters from './LiftHistoryFilters';

const record = (id: string, extra: Partial<LiftRecordResponse> = {}): LiftRecordResponse => ({
  id,
  program: '5-3-1',
  macrocycleNum: 1,
  workoutNum: 1,
  date: '2026-11-02',
  lift: 'Cable Curl',
  setNum: 1,
  weight: 65,
  reps: 10,
  notes: '',
  ...extra,
});

describe('LiftHistoryFilters — modifications (#1152)', () => {
  it('names the modifications on a set beside its reps', () => {
    render(
      <LiftHistoryFilters
        unit="lbs"
        records={[
          record('modified', { modifications: [{ id: 'm-wide', name: 'Wide grip' }] }),
          record('plain', { setNum: 2 }),
        ]}
      />,
    );

    const [, modified, plain] = screen.getAllByRole('row');
    expect(modified).toHaveTextContent('10 · Wide grip');
    expect(plain?.textContent).not.toContain('·');
  });
});
