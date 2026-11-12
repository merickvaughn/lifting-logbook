import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LiftModificationResponse } from '@lifting-logbook/types';
import { ApiClientError } from '@lifting-logbook/api-client';
import LiftModificationsEditor from './LiftModificationsEditor';
import {
  fetchLiftModifications,
  fetchModificationMaxes,
  putModificationMax,
  updateLiftModification,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

jest.mock('@/lib/client-api', () => ({
  fetchLiftModifications: jest.fn(),
  fetchModificationMaxes: jest.fn(),
  updateLiftModification: jest.fn(),
  putModificationMax: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({
  logClientError: jest.fn(),
}));

const mockList = fetchLiftModifications as jest.MockedFunction<typeof fetchLiftModifications>;
const mockMaxes = fetchModificationMaxes as jest.MockedFunction<typeof fetchModificationMaxes>;
const mockUpdate = updateLiftModification as jest.MockedFunction<typeof updateLiftModification>;
const mockPut = putModificationMax as jest.MockedFunction<typeof putModificationMax>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

const modification = (
  id: string,
  name: string,
  extra: Partial<LiftModificationResponse> = {},
): LiftModificationResponse => ({
  id,
  lift: 'cable-curl',
  name,
  description: '',
  maxMode: 'none',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});
const WIDE = modification('m-wide', 'Wide grip', { maxMode: 'own' });
const PAUSED = modification('m-paused', 'Paused', { description: 'Two seconds at the top' });
const maxOf = (modificationId: string, weight: number) => ({
  modificationId,
  weight,
  unit: 'lbs' as const,
  dateUpdated: '2026-11-01T00:00:00.000Z',
});

const renderEditor = () => render(<LiftModificationsEditor program="5-3-1" lift="Cable Curl" />);
const row = async (name: string) => within(await screen.findByRole('group', { name }));

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([WIDE, PAUSED]);
  mockMaxes.mockResolvedValue([maxOf('m-wide', 65)]);
});

describe('LiftModificationsEditor (#1153)', () => {
  it("lists the lift's modifications with their own max", async () => {
    renderEditor();

    const wide = await row('Wide grip');
    expect(wide.getByLabelText('Name')).toHaveValue('Wide grip');
    expect(wide.getByLabelText('Max')).toHaveValue('own');
    expect(wide.getByLabelText('Own max (lbs)')).toHaveValue(65);
    const paused = await row('Paused');
    expect(paused.getByLabelText('Description')).toHaveValue('Two seconds at the top');
    // Only a modification with its own max has one to edit.
    expect(paused.queryByLabelText('Own max (lbs)')).not.toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith('Cable Curl');
    expect(mockMaxes).toHaveBeenCalledWith('5-3-1');
  });

  it('saves only what changed', async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue({ ok: true, data: { ...WIDE, name: 'Wide' } });
    mockPut.mockResolvedValue(maxOf('m-wide', 70));
    renderEditor();

    const wide = await row('Wide grip');
    await user.clear(wide.getByLabelText('Name'));
    await user.type(wide.getByLabelText('Name'), 'Wide');
    await user.clear(wide.getByLabelText('Own max (lbs)'));
    await user.type(wide.getByLabelText('Own max (lbs)'), '70');
    await user.click(wide.getByRole('button', { name: 'Save' }));

    expect(await wide.findByText('Saved.')).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledWith('m-wide', { name: 'Wide' });
    expect(mockPut).toHaveBeenCalledWith('5-3-1', 'm-wide', { weight: 70 });
  });

  it('gives a modification its own max', async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue({ ok: true, data: { ...PAUSED, maxMode: 'own' } });
    mockPut.mockResolvedValue(maxOf('m-paused', 50));
    renderEditor();

    const paused = await row('Paused');
    await user.selectOptions(paused.getByLabelText('Max'), 'own');
    await user.type(paused.getByLabelText('Own max (lbs)'), '50');
    await user.click(paused.getByRole('button', { name: 'Save' }));

    expect(await paused.findByText('Saved.')).toBeInTheDocument();
    expect(mockUpdate).toHaveBeenCalledWith('m-paused', { maxMode: 'own' });
    expect(mockPut).toHaveBeenCalledWith('5-3-1', 'm-paused', { weight: 50 });
    // The mode is saved before the max, which the API takes only for an `own` modification.
    expect(mockUpdate.mock.invocationCallOrder[0]).toBeLessThan(mockPut.mock.invocationCallOrder[0] ?? 0);
  });

  it('leaves an own modification with no max yet without one, when the field stays empty', async () => {
    const user = userEvent.setup();
    mockMaxes.mockResolvedValue([]);
    mockUpdate.mockResolvedValue({ ok: true, data: { ...WIDE, description: 'Hands outside the shoulders' } });
    renderEditor();

    const wide = await row('Wide grip');
    expect(wide.getByText("No max yet: sets plan from Cable Curl's until one is entered or logged.")).toBeInTheDocument();
    await user.click(wide.getByLabelText('Description'));
    await user.paste('Hands outside the shoulders');
    await user.click(wide.getByRole('button', { name: 'Save' }));

    expect(await wide.findByText('Saved.')).toBeInTheDocument();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('refuses a max that is not a positive number, before saving anything', async () => {
    const user = userEvent.setup();
    renderEditor();

    const wide = await row('Wide grip');
    await user.clear(wide.getByLabelText('Own max (lbs)'));
    await user.type(wide.getByLabelText('Own max (lbs)'), '0');
    await user.click(wide.getByRole('button', { name: 'Save' }));

    expect(await wide.findByRole('alert')).toHaveTextContent('Enter a max above 0.');
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("shows the API's reason when the new name is taken", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue({ ok: false, conflictMessage: 'Cable Curl already has a modification named Paused.' });
    renderEditor();

    const wide = await row('Wide grip');
    await user.clear(wide.getByLabelText('Name'));
    await user.type(wide.getByLabelText('Name'), 'Paused');
    await user.click(wide.getByRole('button', { name: 'Save' }));

    expect(await wide.findByRole('alert')).toHaveTextContent('Cable Curl already has a modification named Paused.');
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("shows the API's reason for a 400, and logs it", async () => {
    const user = userEvent.setup();
    const err = new ApiClientError('Only a modification with its own max has one.', 400, 'not-own');
    mockPut.mockRejectedValue(err);
    renderEditor();

    const wide = await row('Wide grip');
    await user.clear(wide.getByLabelText('Own max (lbs)'));
    await user.type(wide.getByLabelText('Own max (lbs)'), '70');
    await user.click(wide.getByRole('button', { name: 'Save' }));

    expect(await wide.findByRole('alert')).toHaveTextContent('Only a modification with its own max has one.');
    expect(mockLog).toHaveBeenCalledWith('putModificationMax', err, { program: '5-3-1', modificationId: 'm-wide' });
  });

  it('asks for a retry when a save fails otherwise', async () => {
    const user = userEvent.setup();
    const err = new Error('network');
    mockUpdate.mockRejectedValue(err);
    renderEditor();

    const paused = await row('Paused');
    await user.type(paused.getByLabelText('Description'), '.');
    await user.click(paused.getByRole('button', { name: 'Save' }));

    expect(await paused.findByRole('alert')).toHaveTextContent('Failed to save. Please try again.');
    expect(mockLog).toHaveBeenCalledWith('updateLiftModification', err, { modificationId: 'm-paused' });
  });

  it.each([
    ['fetchLiftModifications', (err: Error) => mockList.mockRejectedValue(err)],
    ['fetchModificationMaxes', (err: Error) => mockMaxes.mockRejectedValue(err)],
  ])("says so, and logs it under %s, when that read fails", async (op, fail) => {
    const err = new Error('boom');
    fail(err);
    renderEditor();

    expect(await screen.findByRole('status')).toHaveTextContent("Modifications didn't load. Reload to try again.");
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    await waitFor(() => expect(mockLog).toHaveBeenCalledWith(op, err, { program: '5-3-1', lift: 'Cable Curl' }));
    expect(mockLog).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on Save while saving, and sends a second click nowhere', async () => {
    const user = userEvent.setup();
    let finish: (value: Awaited<ReturnType<typeof updateLiftModification>>) => void = () => {};
    mockUpdate.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderEditor();

    const paused = await row('Paused');
    await user.type(paused.getByLabelText('Name'), '!');
    await user.click(paused.getByRole('button', { name: 'Save' }));
    const saving = paused.getByRole('button', { name: 'Saving…' });
    expect(saving).toBeEnabled();
    expect(saving).toHaveFocus();
    await user.click(saving);
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    finish({ ok: true, data: { ...PAUSED, name: 'Paused!' } });
    await waitFor(() => expect(paused.getByRole('status')).toHaveTextContent('Saved.'));
  });

  it('says where to add one when the lift has none', async () => {
    mockList.mockResolvedValue([]);
    renderEditor();

    expect(await screen.findByText('No modifications yet. Add one from the workout logger.')).toBeInTheDocument();
  });
});
