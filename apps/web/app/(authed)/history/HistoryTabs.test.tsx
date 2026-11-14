import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  ImportBatchSummary,
  MacrocycleSummaryResponse,
  TrainingMaxHistoryEntryResponse,
} from '@lifting-logbook/types';
import { undoImport } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import HistoryTabs from './HistoryTabs';
import type { EnrichedRecord } from './page';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({ undoImport: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
const mockUndo = undoImport as jest.MockedFunction<typeof undoImport>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

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

  // #1257: an import is undone from here once the wizard is gone.
  describe('Undo import', () => {
    const older: ImportBatchSummary = { id: 'b-old', program: '5-3-1', createdAt: '2026-10-01T00:00:00.000Z', macrocycleIds: ['a', 'b'] };
    const newer: ImportBatchSummary = { id: 'b-new', program: 'rpt', createdAt: '2026-11-01T00:00:00.000Z', macrocycleIds: ['b'] };

    beforeEach(() => {
      refresh.mockReset();
      mockUndo.mockReset();
      mockLog.mockReset();
    });

    async function openTab() {
      const user = userEvent.setup();
      render(
        <HistoryTabs
          records={[]}
          tmEntries={[]}
          macrocycles={[
            macrocycle({ id: 'a', macrocycleNum: 1, origin: 'imported' }),
            macrocycle({ id: 'b', macrocycleNum: 2, origin: 'imported' }),
            macrocycle({ id: 'c', macrocycleNum: 3, current: true }),
          ]}
          imports={[newer, older]}
          unit="lbs"
        />,
      );
      await user.click(screen.getByRole('tab', { name: 'Macrocycles' }));
      return user;
    }

    it('offers it only on an imported macrocycle, for the newest import that touched it', async () => {
      const user = await openTab();
      expect(screen.queryByRole('button', { name: 'Undo import of macrocycle 3' })).not.toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
      mockUndo.mockResolvedValue({ batchId: 'b-new', restored: 3, skipped: 0, flagged: [] });

      await user.click(screen.getByRole('button', { name: 'Undo import of macrocycle 2' }));
      const row = screen.getAllByRole('row')[2];
      const confirm = within(row).getByRole('button', { name: 'Undo import' });
      // Focus moves to the confirm button, which the question describes.
      expect(confirm).toHaveFocus();
      expect(confirm).toHaveAccessibleDescription(/Every set it added goes/);
      await user.click(confirm);

      expect(mockUndo).toHaveBeenCalledWith('rpt', 'b-new', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
      expect(refresh).toHaveBeenCalled();
    });

    it('reports what the undo did, and moves focus to it', async () => {
      const user = await openTab();
      mockUndo.mockResolvedValue({
        batchId: 'b-old',
        restored: 4,
        skipped: 1,
        flagged: [{ key: '1:x', reason: 'modified since import' }],
      });

      await user.click(screen.getByRole('button', { name: 'Undo import of macrocycle 1' }));
      await user.click(screen.getByRole('button', { name: 'Undo import' }));

      const status = await screen.findByText('Undo complete: 4 restored, 1 skipped, 1 flagged (modified since import).');
      expect(status.closest('[role="status"]')).not.toBeNull();
      expect(status).toHaveFocus();
    });

    it('runs one undo at a time: every Undo waits while one runs', async () => {
      const user = await openTab();
      let finish: (value: { batchId: string; restored: number; skipped: number; flagged: [] }) => void = () => {};
      mockUndo.mockReturnValue(new Promise((resolve) => (finish = resolve)));

      await user.click(screen.getByRole('button', { name: 'Undo import of macrocycle 2' }));
      await user.click(screen.getByRole('button', { name: 'Undo import' }));

      expect(screen.getByRole('button', { name: 'Undo import of macrocycle 1' })).toBeDisabled();
      finish({ batchId: 'b-new', restored: 1, skipped: 0, flagged: [] });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Undo import of macrocycle 1' })).toBeEnabled());
    });

    it('opens one confirm at a time', async () => {
      const user = await openTab();
      await user.click(screen.getByRole('button', { name: 'Undo import of macrocycle 1' }));
      await user.click(screen.getByRole('button', { name: 'Undo import of macrocycle 2' }));

      expect(screen.getAllByRole('button', { name: 'Undo import' })).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Undo import of macrocycle 1' })).toBeInTheDocument();
    });

    it('asks first, and does nothing on Cancel, returning focus to the Undo button', async () => {
      const user = await openTab();
      await user.click(screen.getByRole('button', { name: 'Undo import of macrocycle 1' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockUndo).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Undo import of macrocycle 1' })).toHaveFocus();
    });

    it('shows and reports a failed undo', async () => {
      const user = await openTab();
      const failure = new Error('Undo import failed (HTTP 500)');
      mockUndo.mockRejectedValue(failure);

      await user.click(screen.getByRole('button', { name: 'Undo import of macrocycle 1' }));
      await user.click(screen.getByRole('button', { name: 'Undo import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Undo import failed (HTTP 500)');
      expect(mockLog).toHaveBeenCalledWith('undoImport', failure, { programId: '5-3-1', batchId: 'b-old' });
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
