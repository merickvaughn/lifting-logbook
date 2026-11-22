import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupplementAsOfResponse, SupplementChange, SupplementStackResponse } from '@lifting-logbook/types';
import { dose, item } from '@/lib/__tests__/supplementsTestStack';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({
  restoreSupplementItem: jest.fn(),
  fetchSupplementChanges: jest.fn(),
  fetchSupplementsAsOf: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/calendarDay', () => ({ localToday: () => '2026-11-22' }));

import { fetchSupplementChanges, fetchSupplementsAsOf, restoreSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import HistoryDialog, { HISTORY_PAGE } from './HistoryDialog';

const restore = restoreSupplementItem as jest.Mock;
const changes = fetchSupplementChanges as jest.Mock;
const asOf = fetchSupplementsAsOf as jest.Mock;

// Fixture log: product names, amounts and timing only.
const preX = item('pre-x', 'Nutricost Pre-X', { doses: [dose('pre', '1 scoop', ['lift'])] });
const glycine = item('glycine', 'Glycine', { doses: [dose('am', '3 g')] });
const creatine = item('creatine', 'Creatine monohydrate', { doses: [dose('pre', '', ['lift']), dose('all', '5 g')] });
const ashwa = item('ashwa', 'Ashwagandha', { status: 'pending', doses: [dose('pm', '600 mg')] });
const mixPart = item('part', 'Citrulline', { doses: [dose('pre', '6 g', ['lift'])] });
const mix = item('mix', 'Pump mix', { parts: [{ itemId: 'part', name: 'Citrulline', ingredients: [] }] });

const LOG: SupplementChange[] = [
  { seq: 1, date: '2025-12-31', type: 'added', item: preX },
  { seq: 2, date: '2026-11-18', type: 'added', item: glycine },
  { seq: 3, date: '2026-11-19', type: 'added', item: creatine },
  { seq: 4, date: '2026-11-19', type: 'moved_to_pending', itemId: 'pre-x' },
  { seq: 5, date: '2026-11-20', type: 'removed', item: glycine },
  { seq: 6, date: '2026-11-20', type: 'added', item: mixPart },
  { seq: 7, date: '2026-11-20', type: 'folded_into_mix', mixId: 'mix', itemId: 'part' },
  { seq: 8, date: '2026-11-21', type: 'removed', item: mixPart },
];
// Glycine was removed; Citrulline is folded into Pump mix, so only the mix holds it.
const CURRENT: SupplementStackResponse = { items: [preX, creatine, mix], dayTypes: [], caffeineCutoff: '15:00' };

const asOfOf = (over: Partial<SupplementAsOfResponse> = {}): SupplementAsOfResponse => ({
  items: [preX, glycine, creatine, ashwa],
  dayTypes: [{ id: 'lift', name: 'Lift day' }],
  firstChangeDate: '2025-12-31',
  anomalies: [],
  ...over,
});

const deferred = <T,>() => {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const onClose = jest.fn();
const setup = (props: Partial<Parameters<typeof HistoryDialog>[0]> = {}) =>
  render(<HistoryDialog stack={CURRENT} initialDate="2026-11-19" onClose={onClose} {...props} />);
const changeRows = () => within(screen.getByRole('region', { name: 'Changes' })).getAllByRole('listitem');

beforeEach(() => {
  jest.clearAllMocks();
  changes.mockResolvedValue(LOG);
  asOf.mockResolvedValue(asOfOf());
});

describe('HistoryDialog', () => {
  it('lists the items active at the end of the date with their doses, and the log newest first', async () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Supplement history' })).toBeInTheDocument();
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-19');
    expect(asOf).toHaveBeenCalledWith('2026-11-19');
    expect(changes).toHaveBeenCalledWith({ limit: HISTORY_PAGE });

    const on = screen.getByRole('region', { name: 'What was I on?' });
    expect(await within(on).findByText('3 items active at the end of that day.')).toBeInTheDocument();
    const items = within(on).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Nutricost Pre-X — 1 scoop · Pre-workout (Lift day)',
      'Glycine — 3 g · Morning',
      'Creatine monohydrate — dose? · Pre-workout (Lift day) + 5 g · Throughout the day',
    ]);
    // Pending isn't active.
    expect(within(on).queryByText(/Ashwagandha/)).toBeNull();

    const rows = await waitFor(() => changeRows());
    expect(rows).toHaveLength(LOG.length);
    expect(rows[0]).toHaveTextContent('Nov 21Removed Citrulline');
    expect(within(rows[0]).getByText('Removed').tagName).toBe('STRONG');
    expect(rows[4]).toHaveTextContent('Nov 19Moved Nutricost Pre-X to Pending');
    expect(rows[7]).toHaveTextContent('Dec 31, 2025Added Nutricost Pre-X');
  });

  it('opens at today when no date is given', async () => {
    setup({ initialDate: undefined });
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-22');
    expect(asOf).toHaveBeenCalledWith('2026-11-22');
    await screen.findByText(/active at the end of that day/);
  });

  it('says Loading until the stack for the date arrives', async () => {
    const pending = deferred<SupplementAsOfResponse>();
    asOf.mockReturnValue(pending.promise);
    setup();
    expect(within(screen.getByRole('region', { name: 'What was I on?' })).getByText('Loading…')).toBeInTheDocument();
    await act(async () => pending.resolve(asOfOf()));
    expect(screen.getByText('3 items active at the end of that day.')).toBeInTheDocument();
  });

  it('shows a picked date, and asks for nothing while the field holds part of one', async () => {
    setup();
    await screen.findByText('3 items active at the end of that day.');
    asOf.mockResolvedValue(asOfOf({ items: [creatine] }));
    const field = screen.getByLabelText('Date');
    fireEvent.change(field, { target: { value: '0002-11-20' } });
    fireEvent.change(field, { target: { value: '' } });
    expect(asOf).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: '2026-11-21' } });
    expect(asOf).toHaveBeenLastCalledWith('2026-11-21');
    expect(await screen.findByText('1 item active at the end of that day.')).toBeInTheDocument();
  });

  it('shows the latest date picked when an earlier request answers last', async () => {
    const first = deferred<SupplementAsOfResponse>();
    const second = deferred<SupplementAsOfResponse>();
    asOf.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    setup();
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-21' } });
    await act(async () => second.resolve(asOfOf({ items: [creatine] })));
    await act(async () => first.resolve(asOfOf()));
    expect(screen.getByText('1 item active at the end of that day.')).toBeInTheDocument();
    expect(screen.queryByText('3 items active at the end of that day.')).toBeNull();
  });

  it('names day types as they were then, and "a removed day type" for one the date lacks', async () => {
    const gone = item('x', 'Nutricost Pre-X', { doses: [dose('pre', '1 scoop', ['deleted'])] });
    asOf.mockResolvedValue(asOfOf({ items: [gone] }));
    setup();
    expect(await screen.findByText(/1 scoop · Pre-workout \(a removed day type\)/)).toBeInTheDocument();
    expect(screen.queryByText(/deleted/)).toBeNull();
  });

  it('says when history starts for a date before the first change', async () => {
    asOf.mockResolvedValue(asOfOf({ items: [], firstChangeDate: '2026-11-18' }));
    setup({ initialDate: '2026-11-01' });
    expect(await screen.findByText('0 items active at the end of that day. History starts on Nov 18, 2026.')).toBeInTheDocument();
  });

  it('says nothing has been logged when the log is empty', async () => {
    asOf.mockResolvedValue(asOfOf({ items: [], firstChangeDate: null }));
    changes.mockResolvedValue([]);
    setup();
    expect(await screen.findByText(/Nothing has been logged yet/)).toBeInTheDocument();
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument();
  });

  it('says so once, without ids, when changes could not be replayed', async () => {
    asOf.mockResolvedValue(asOfOf({ anomalies: [{ seq: 5, type: 'started', itemId: 'ghost-id', reason: 'unknown-item' }] }));
    setup();
    expect(await screen.findAllByText(/Some changes couldn’t be replayed/)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('ghost-id');
  });

  it('offers Restore on a removal it can undo, and none for an item folded into a mix or in the stack', async () => {
    setup();
    expect(await screen.findByRole('button', { name: 'Restore Glycine' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Restore/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Restore Citrulline/ })).toBeNull();
  });

  it('restores with the lifter’s date, keeps focus in the dialog, announces it there, and re-reads the log and the stack', async () => {
    const back: SupplementStackResponse = { ...CURRENT, items: [...CURRENT.items, glycine] };
    const answer = deferred<SupplementStackResponse>();
    restore.mockReturnValue(answer.promise);
    const restoredLog = [...LOG, { seq: 9, date: '2026-11-22', type: 'restored', itemId: 'glycine' } as const];
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Glycine' }));
    expect(restore).toHaveBeenCalledWith('glycine', '2026-11-22');
    expect(screen.getByRole('button', { name: 'Restore Glycine' })).toHaveTextContent('Restoring…');
    expect(screen.getByRole('button', { name: 'Restore Glycine' })).toBeDisabled();

    changes.mockResolvedValue(restoredLog);
    await act(async () => answer.resolve(back));
    expect(screen.getByTestId('history-announcement')).toHaveTextContent('Restored Glycine.');
    expect(screen.getByRole('dialog')).toContainElement(screen.getByTestId('history-announcement'));
    expect(screen.getByRole('heading', { name: 'Changes' })).toHaveFocus();
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
    expect(asOf).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenLastCalledWith({ limit: HISTORY_PAGE });
    // The re-read log is merged by seq: the restore is on top, and nothing is listed twice.
    await waitFor(() => expect(changeRows()).toHaveLength(restoredLog.length));
    expect(changeRows()[0]).toHaveTextContent('Nov 22Restored Glycine');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a failed restore through logClientError and says so in the dialog', async () => {
    const err = new Error('409 Conflict');
    restore.mockRejectedValue(err);
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore Glycine' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t restore Glycine');
    expect(logClientError).toHaveBeenCalledWith('supplements.restoreItem', err, { itemId: 'glycine' });
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('history-announcement')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Restore Glycine' })).toBeEnabled();

    // Trying again clears the message.
    restore.mockResolvedValue({ ...CURRENT, items: [...CURRENT.items, glycine] });
    await userEvent.click(screen.getByRole('button', { name: 'Restore Glycine' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('reports a log that would not load', async () => {
    const err = new Error('500');
    changes.mockRejectedValue(err);
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the history');
    expect(logClientError).toHaveBeenCalledWith('supplements.history.load', err, { part: 'changes' });
    // The stack for the date still shows.
    expect(await screen.findByText('3 items active at the end of that day.')).toBeInTheDocument();
  });

  it('reports a stack that would not load for the date', async () => {
    const err = new Error('500');
    asOf.mockRejectedValue(err);
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the history');
    expect(logClientError).toHaveBeenCalledWith('supplements.history.load', err, { part: 'asOf', date: '2026-11-19' });
    expect(within(screen.getByRole('region', { name: 'What was I on?' })).queryByText('Loading…')).toBeNull();
  });

  it('pages the log back from the earliest change loaded, once, until a short page', async () => {
    const full = Array.from({ length: HISTORY_PAGE }, (_, i): SupplementChange => ({ seq: 201 + i, date: '2026-11-20', type: 'started', itemId: 'pre-x' }));
    changes.mockResolvedValue(full);
    const page = deferred<SupplementChange[]>();
    setup();
    const more = await screen.findByRole('button', { name: 'Show earlier changes' });
    changes.mockReturnValue(page.promise);
    await userEvent.click(more);
    expect(more).toBeDisabled();
    expect(more).toHaveTextContent('Loading earlier changes…');
    await userEvent.click(more);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenLastCalledWith({ beforeSeq: 201, limit: HISTORY_PAGE });
    await act(async () => page.resolve([{ seq: 200, date: '2026-11-01', type: 'added', item: item('old', 'Old Thing') }]));
    expect(screen.getByText('Old Thing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /earlier changes/ })).toBeNull();
  });

  it('reports a page that would not load, and clears the message once one does', async () => {
    const full = Array.from({ length: HISTORY_PAGE }, (_, i): SupplementChange => ({ seq: 201 + i, date: '2026-11-20', type: 'started', itemId: 'pre-x' }));
    changes.mockResolvedValue(full);
    setup();
    const more = await screen.findByRole('button', { name: 'Show earlier changes' });
    const err = new Error('503');
    changes.mockRejectedValueOnce(err);
    await userEvent.click(more);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load earlier changes');
    expect(logClientError).toHaveBeenCalledWith('supplements.history.loadEarlier', err, { beforeSeq: 201 });
    changes.mockResolvedValueOnce(full.map((c) => ({ ...c, seq: c.seq - HISTORY_PAGE })));
    await userEvent.click(more);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(changeRows()).toHaveLength(2 * HISTORY_PAGE);
  });

  it('offers no earlier page when the log fit in one', async () => {
    setup();
    await screen.findByRole('button', { name: 'Restore Glycine' });
    expect(screen.queryByRole('button', { name: /earlier changes/ })).toBeNull();
  });

  it('closes with ×', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
