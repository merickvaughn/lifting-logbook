import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClientError } from '@lifting-logbook/api-client';
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

const tab = (name: string, rows: string[][], over: Record<string, unknown> = {}) => ({
  name,
  rows,
  links: rows.map((r) => r.map(() => '')),
  skipReason: null,
  ...over,
});
const rows = [
  ['Compound', 'Amount', 'Timing', 'Purpose', 'Notes'],
  ['Beta-alanine', '3-6g', 'TID', 'fatigue', ''],
  ['Beta-alanine', '1.5g', 'bedtime', '', ''],
  ['Probiotic', '-', 'anytime', 'gut', ''],
  ['Nitrates', '???', '???', '', ''],
];
const SHEET = { tabs: [tab('Supplements', rows)] };
const LINK = 'https://docs.google.com/spreadsheets/d/abc/edit';

beforeEach(() => jest.clearAllMocks());

function setup(items: { name: string; catalogKey?: string }[] = []) {
  const user = userEvent.setup();
  const onCancel = jest.fn();
  const onDone = jest.fn();
  render(<ImportDialog items={items} onCancel={onCancel} onDone={onDone} />);
  return { user, onCancel, onDone };
}

async function toTabs(items: { name: string; catalogKey?: string }[] = []) {
  const s = setup(items);
  await s.user.click(screen.getByLabelText('Google Sheets link'));
  await s.user.paste(LINK);
  await s.user.click(screen.getByRole('button', { name: 'Read sheet' }));
  await screen.findByRole('heading', { name: 'Pick a tab' });
  return s;
}

async function toReview(items: { name: string; catalogKey?: string }[] = []) {
  const s = await toTabs(items);
  await s.user.click(screen.getByRole('button', { name: 'Supplements' }));
  return s;
}

/** The body of the first import request. */
const imported = () => doImport.mock.calls[0]?.[0];

describe('ImportDialog', () => {
  it('moves focus to each step’s heading, and Back keeps the link', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    const { user } = await toTabs();
    expect(screen.getByRole('heading', { name: 'Pick a tab' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Supplements' }));
    expect(screen.getByRole('heading', { name: 'Review rows' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Pick a tab' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Paste a link' })).toHaveFocus();
    expect(screen.getByLabelText('Google Sheets link')).toHaveValue(LINK);
  });

  it('lists each tab with its importable rows, and a tab it can’t import with the reason', async () => {
    fetchSheet.mockResolvedValue({
      tabs: [
        tab('Supplements', rows),
        tab('One', [['Compound'], ['Iron']]),
        tab('BIG', [], { links: [], skipReason: 'More than 500 rows, the per-import limit.' }),
      ],
    });
    await toTabs();
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Supplements 4 rows',
      'One 1 row',
      'BIG Not importable: More than 500 rows, the per-import limit.',
    ]);
    expect(within(list).queryByRole('button', { name: 'BIG' })).toBeNull();
  });

  it('says a sheet with no tabs with rows has none, without reporting an error', async () => {
    fetchSheet.mockResolvedValue({ tabs: [] });
    await toTabs();
    expect(screen.getByText('That sheet has no tabs with rows.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(logClientError).not.toHaveBeenCalled();
  });

  it('says so when a tab has no Compound column, and stays on the tab step', async () => {
    fetchSheet.mockResolvedValue({ tabs: [tab('Notes', [['Date', 'Text'], ['1/1', 'hi']]), tab('Supplements', rows)] });
    const { user } = await toTabs();
    await user.click(screen.getByRole('button', { name: 'Notes' }));
    expect(screen.getByRole('alert')).toHaveTextContent('“Notes” has no Compound column with rows. Pick another tab.');
    expect(screen.getByRole('heading', { name: 'Pick a tab' })).toBeInTheDocument();
    expect(logClientError).not.toHaveBeenCalled();
  });

  it('numbers rows as the sheet does, starts a name-only row as pending, and flags the duplicate', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    await toReview();
    expect(screen.getByText('Row 5')).toBeInTheDocument();
    expect(screen.getByLabelText('Nitrates (row 5)')).toHaveValue('pending');
    expect(screen.getByLabelText('Probiotic (row 4)')).toHaveValue('active');
    const dup = screen.getByLabelText('Beta-alanine (row 3)');
    expect(dup).toHaveAccessibleDescription(
      '1.5g · bedtime Same supplement as Beta-alanine (row 2). Merge it into that row, or keep both.',
    );
    expect(screen.getByLabelText('Beta-alanine (row 2)')).toHaveAccessibleDescription('3-6g · TID');
  });

  it('flags a row already in the stack and starts it as Skip', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    await toReview([{ name: 'Probiotic' }]);
    const probiotic = screen.getByLabelText('Probiotic (row 4)');
    expect(probiotic).toHaveValue('skip');
    expect(probiotic).toHaveAccessibleDescription('anytime Already in your stack.');
  });

  it('imports the reviewed rows once: a skipped row left out, the duplicate merged, a row made pending', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    doImport.mockResolvedValue({});
    const { user, onDone } = await toReview();
    await user.selectOptions(screen.getByLabelText('Beta-alanine (row 3)'), 'merge');
    await user.selectOptions(screen.getByLabelText('Probiotic (row 4)'), 'skip');
    await user.selectOptions(screen.getByLabelText('Beta-alanine (row 2)'), 'pending');
    await user.click(screen.getByRole('button', { name: 'Import 2 items' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(2));
    expect(doImport).toHaveBeenCalledTimes(1);
    const [, today] = doImport.mock.calls[0];
    expect(today).toBe('2026-11-22');
    expect(imported().source).toBe('Supplements');
    expect(imported().skipped).toBe(1);
    expect(imported().rows.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([
      ['Beta-alanine', 'pending'],
      ['Nitrates', 'pending'],
    ]);
    // The first row's amount has no dose to hold it, so it stays in the timing text.
    expect(imported().rows[0]).toMatchObject({ timing: '3-6g TID; bedtime', doses: [{ slot: 'pm', amount: '1.5g' }] });
    expect(refresh).toHaveBeenCalled();
  });

  it('keeps both duplicates as separate items', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    doImport.mockResolvedValue({});
    const { user } = await toReview();
    await user.click(screen.getByRole('button', { name: 'Import 4 items' }));
    await waitFor(() => expect(doImport).toHaveBeenCalledTimes(1));
    expect(imported().rows.map((r: { name: string }) => r.name)).toEqual(['Beta-alanine', 'Beta-alanine', 'Probiotic', 'Nitrates']);
  });

  it('won’t merge into a skipped row, and a row merging into one that becomes skipped goes back to Active', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    const { user } = await toReview();
    const first = screen.getByLabelText('Beta-alanine (row 2)');
    const dup = screen.getByLabelText('Beta-alanine (row 3)');
    await user.selectOptions(dup, 'merge');
    await user.selectOptions(first, 'skip');
    expect(dup).toHaveValue('active');
    expect(within(dup).getByRole('option', { name: 'Merge into row 2' })).toBeDisabled();
    expect(dup).toHaveAccessibleDescription(
      '1.5g · bedtime Same supplement as Beta-alanine (row 2). Row 2 is skipped, so this row can’t be merged into it.',
    );
  });

  it('reports a failed read with a fixed sentence, adding the API’s reason for a 4xx', async () => {
    fetchSheet.mockRejectedValue(new ApiClientError('That sheet is not shared.', 422));
    const { user } = setup();
    await user.click(screen.getByLabelText('Google Sheets link'));
    await user.paste(LINK);
    await user.click(screen.getByRole('button', { name: 'Read sheet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t read that sheet. Check the link and that it’s shared. That sheet is not shared.',
    );
    expect(logClientError).toHaveBeenCalledWith('supplements.importFetch', expect.any(ApiClientError), {});
  });

  it('leaves out the API’s message for a 5xx or a network error', async () => {
    fetchSheet.mockRejectedValue(new ApiClientError('API 502 Bad Gateway for /supplements/import/google-sheet', 502));
    const { user } = setup();
    await user.click(screen.getByLabelText('Google Sheets link'));
    await user.paste(LINK);
    await user.click(screen.getByRole('button', { name: 'Read sheet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Couldn’t read that sheet\. Check the link and that it’s shared\.$/);
  });

  it('says nothing was saved when the import fails, and reports the counts', async () => {
    fetchSheet.mockResolvedValue(SHEET);
    doImport.mockRejectedValue(new Error('boom'));
    const { user, onDone } = await toReview();
    await user.click(screen.getByRole('button', { name: 'Import 4 items' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Couldn’t import\. Nothing was saved\.$/);
    expect(logClientError).toHaveBeenCalledWith('supplements.import', expect.any(Error), { rows: 4, imported: 4 });
    expect(refresh).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onCancel when closed with ×', async () => {
    const { user, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
