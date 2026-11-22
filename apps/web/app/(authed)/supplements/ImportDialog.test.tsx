import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportDialog from './ImportDialog';
import { fetchSupplementSheet, importSupplements } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({ fetchSupplementSheet: jest.fn(), importSupplements: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/calendarDay', () => ({ localToday: () => '2026-11-22' }));

const fetchSheet = fetchSupplementSheet as jest.Mock;
const doImport = importSupplements as jest.Mock;

const rows = [
  ['Compound', 'Amount', 'Timing', 'Purpose', 'Notes'],
  ['Beta-alanine', '3-6g', 'TID', 'fatigue', ''],
  ['Beta-alanine', '1.5g', 'bedtime', '', ''],
  ['Probiotic', '-', 'anytime', 'gut', ''],
  ['Nitrates', '???', '???', '', ''],
];
const SHEET = { tabs: [{ name: 'Supplements', rows, links: rows.map((r) => r.map(() => '')) }] };

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
});
beforeEach(() => jest.clearAllMocks());

async function toReview() {
  const user = userEvent.setup();
  render(<ImportDialog onClose={jest.fn()} />);
  await user.click(screen.getByLabelText('Google Sheets link'));
  await user.paste('https://docs.google.com/spreadsheets/d/abc/edit');
  await user.click(screen.getByRole('button', { name: 'Read sheet' }));
  await user.click(await screen.findByRole('button', { name: 'Supplements' }));
  return user;
}

describe('ImportDialog', () => {
  it('starts a name-only row as pending, flags the duplicate, and lets each row be marked', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    await toReview();
    expect(screen.getByLabelText('Nitrates (row 4)')).toHaveValue('pending');
    expect(screen.getByLabelText('Probiotic (row 3)')).toHaveValue('active');
    expect(screen.getByRole('note')).toHaveTextContent('Same name as Beta-alanine (row 1)');
  });

  it('imports the reviewed rows once: skipped rows left out, the duplicate merged', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    doImport.mockResolvedValue({});
    const user = await toReview();
    await user.selectOptions(screen.getByLabelText('Beta-alanine (row 2)'), 'merge');
    await user.selectOptions(screen.getByLabelText('Probiotic (row 3)'), 'skip');
    await user.click(screen.getByRole('button', { name: 'Import 2 items' }));
    await waitFor(() => expect(doImport).toHaveBeenCalledTimes(1));
    const [body, today] = doImport.mock.calls[0];
    expect(today).toBe('2026-11-22');
    expect(body.source).toBe('Supplements');
    expect(body.rows.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([
      ['Beta-alanine', 'active'],
      ['Nitrates', 'pending'],
    ]);
    expect(body.rows[0]).toMatchObject({ timing: 'TID; bedtime', doses: [{ slot: 'pm', amount: '1.5g' }] });
    expect(refresh).toHaveBeenCalled();
  });

  it('reports a failed read through logClientError and says why', async () => {
    fetchSheet.mockRejectedValue(new Error('That sheet is not shared.'));
    const user = userEvent.setup();
    render(<ImportDialog onClose={jest.fn()} />);
    await user.click(screen.getByLabelText('Google Sheets link'));
    await user.paste('https://docs.google.com/spreadsheets/d/abc/edit');
    await user.click(screen.getByRole('button', { name: 'Read sheet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That sheet is not shared.');
    expect(logClientError).toHaveBeenCalledWith('supplements.importFetch', expect.any(Error));
  });

  it('says nothing was saved when the import fails', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    doImport.mockRejectedValue(new Error('boom'));
    const user = await toReview();
    await user.click(screen.getByRole('button', { name: /^Import \d+ items$/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
