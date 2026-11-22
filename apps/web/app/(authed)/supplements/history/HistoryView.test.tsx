import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupplementAsOfResponse, SupplementChange, SupplementStackResponse } from '@lifting-logbook/types';
import { dose, item } from '@/lib/__tests__/supplementsTestStack';

const refresh = jest.fn();
const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push }) }));
jest.mock('@/lib/client-api', () => ({ restoreSupplementItem: jest.fn(), fetchSupplementChanges: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

import { fetchSupplementChanges, restoreSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import HistoryView from './HistoryView';

const restore = restoreSupplementItem as jest.Mock;
const earlier = fetchSupplementChanges as jest.Mock;

// Fixture log: product names, amounts and timing only.
const preX = item('pre-x', 'Nutricost Pre-X', { doses: [dose('pre', '1 scoop', ['lift'])] });
const glycine = item('glycine', 'Glycine', { doses: [dose('am', '3 g')] });
const creatine = item('creatine', 'Creatine monohydrate', { status: 'pending', doses: [dose('am', '5 g')] });
const mixPart = item('part', 'Citrulline', { doses: [dose('pre', '6 g', ['lift'])] });
const mix = item('mix', 'Pump mix', { parts: [{ itemId: 'part', name: 'Citrulline', ingredients: [] }] });

const CHANGES: SupplementChange[] = [
  { seq: 1, date: '2026-11-18', type: 'added', item: preX },
  { seq: 2, date: '2026-11-18', type: 'added', item: glycine },
  { seq: 3, date: '2026-11-19', type: 'added', item: creatine },
  { seq: 4, date: '2026-11-19', type: 'moved_to_pending', itemId: 'pre-x' },
  { seq: 5, date: '2026-11-20', type: 'removed', item: glycine },
  { seq: 6, date: '2026-11-20', type: 'added', item: mixPart },
  { seq: 7, date: '2026-11-20', type: 'folded_into_mix', mixId: 'mix', itemId: 'part' },
  { seq: 8, date: '2026-11-20', type: 'day_types_set', dayTypes: [{ id: 'lift', name: 'Push day' }] },
];
// Glycine was removed; Citrulline is folded into Pump mix, so only the mix is in the stack.
const CURRENT: SupplementStackResponse = { items: [preX, creatine, mix], dayTypes: [], caffeineCutoff: '15:00' };

const asOf = (over: Partial<SupplementAsOfResponse> = {}): SupplementAsOfResponse => ({
  items: [],
  dayTypes: [{ id: 'lift', name: 'Lift day' }],
  firstChangeDate: '2026-11-18',
  anomalies: [],
  ...over,
});

const setup = (over: Partial<Parameters<typeof HistoryView>[0]> = {}) =>
  render(<HistoryView date="2026-11-19" asOf={asOf({ items: [preX, glycine] })} changes={CHANGES} current={CURRENT} {...over} />);

beforeEach(() => jest.clearAllMocks());

describe('HistoryView', () => {
  it('lists the stack at the end of the date with its doses, and the change log newest first in words', () => {
    setup();
    expect(screen.getByLabelText('What was I on?')).toHaveValue('2026-11-19');
    expect(screen.getByText('Nutricost Pre-X')).toBeInTheDocument();
    expect(screen.getByText('Pre-workout (Lift day) · 1 scoop')).toBeInTheDocument();
    expect(screen.getByText('Morning · 3 g')).toBeInTheDocument();

    const changes = within(screen.getByRole('heading', { name: 'Changes' }).parentElement as HTMLElement).getAllByRole('listitem');
    expect(changes[0]).toHaveTextContent('Nov 20, 2026 Day types changed');
    expect(changes).toHaveLength(CHANGES.length);
    expect(screen.getByText('Moved Nutricost Pre-X to Pending')).toBeInTheDocument();
    expect(screen.getByText('Added Creatine monohydrate')).toBeInTheDocument();
    expect(screen.getByText('Folded Citrulline into Pump mix')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Day types changed')).toBeLessThan(text.indexOf('Moved Nutricost Pre-X to Pending'));
    expect(text.indexOf('Moved Nutricost Pre-X to Pending')).toBeLessThan(text.indexOf('Added Nutricost Pre-X'));
  });

  it('goes to the picked date', () => {
    setup();
    fireEvent.change(screen.getByLabelText('What was I on?'), { target: { value: '2026-11-20' } });
    expect(push).toHaveBeenLastCalledWith('/supplements/history?date=2026-11-20');
  });

  it('labels a dose with the day type names of that date, and "a removed day type" for one it lacks', () => {
    const gone = item('x', 'Nutricost Pre-X', { doses: [dose('pre', '1 scoop', ['deleted'])] });
    setup({ asOf: asOf({ items: [gone], dayTypes: [{ id: 'lift', name: 'Lift day' }] }) });
    expect(screen.getByText('Pre-workout (a removed day type) · 1 scoop')).toBeInTheDocument();
    expect(screen.queryByText(/deleted/)).toBeNull();
  });

  it('shows the names the day types had then, not the ones they have now', () => {
    // The log renames "lift" to "Push day" on Nov 20; as of Nov 19 it was "Lift day".
    setup();
    expect(screen.getByText('Pre-workout (Lift day) · 1 scoop')).toBeInTheDocument();
    expect(screen.queryByText(/Push day/)).toBeNull();
  });

  it('says history starts at the first change instead of showing an empty stack', () => {
    setup({ date: '2026-11-01', asOf: asOf() });
    expect(screen.getByText('History starts on Nov 18, 2026; nothing was logged before then.')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in the stack/)).toBeNull();
  });

  it('says nothing has been logged when the log is empty', () => {
    setup({ asOf: asOf({ firstChangeDate: null }), changes: [], current: { ...CURRENT, items: [] } });
    expect(screen.getByText(/Nothing has been logged yet/)).toBeInTheDocument();
    expect(screen.getByText('No changes yet.')).toBeInTheDocument();
  });

  it('says so once, without ids, when changes could not be replayed', () => {
    setup({ asOf: asOf({ items: [preX], anomalies: [{ seq: 5, type: 'started', itemId: 'ghost-id', reason: 'unknown-item' }] }) });
    expect(screen.getAllByText(/Some changes couldn’t be replayed/)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('ghost-id');
  });

  it('offers Restore on the removal of an item that is not in the stack, and none on an item folded into a mix', () => {
    setup();
    expect(screen.getAllByRole('button', { name: /^Restore/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Restore Glycine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore Citrulline/ })).toBeNull();
  });

  it('offers no Restore for an item that is already back in the stack', () => {
    setup({ current: { ...CURRENT, items: [...CURRENT.items, glycine] } });
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
  });

  it('restores with the lifter’s date, refreshes and announces it politely', async () => {
    restore.mockResolvedValue(CURRENT);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Restore Glycine' }));
    expect(restore).toHaveBeenCalledWith('glycine', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByTestId('supp-announcement')).toHaveTextContent('Restored Glycine');
    expect(screen.getByTestId('supp-announcement')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a failed restore through logClientError and says so in the view', async () => {
    const err = new Error('409 Conflict');
    restore.mockRejectedValue(err);
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Restore Glycine' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t restore Glycine');
    expect(logClientError).toHaveBeenCalledWith('supplements.restoreItem', err, { itemId: 'glycine' });
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('supp-announcement')).toBeEmptyDOMElement();
  });

  it('pages the log back from the first change loaded, once a full page was returned', async () => {
    const full = Array.from({ length: 200 }, (_, i): SupplementChange => ({ seq: 201 + i, date: '2026-11-20', type: 'started', itemId: 'pre-x' }));
    earlier.mockResolvedValue([{ seq: 200, date: '2026-11-01', type: 'added', item: item('old', 'Old Thing') }]);
    setup({ changes: full });
    await userEvent.click(screen.getByRole('button', { name: 'Show earlier changes' }));
    expect(earlier).toHaveBeenCalledWith({ beforeSeq: 201 });
    expect(await screen.findByText('Added Old Thing')).toBeInTheDocument();
    // A short page was the start of the log.
    expect(screen.queryByRole('button', { name: 'Show earlier changes' })).toBeNull();
  });

  it('offers no earlier page when the log fit in one', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'Show earlier changes' })).toBeNull();
    expect(within(document.body).queryByText(/earlier/)).toBeNull();
  });
});
