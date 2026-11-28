import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomProgramResponse } from '@lifting-logbook/types';
import { fetchLiftModificationsByLift } from '@/lib/client-api';
import ProgramEditor from './ProgramEditor';
import { updateCustomProgram } from './actions';

jest.mock('@/lib/client-api', () => ({ fetchLiftModificationsByLift: jest.fn() }));
jest.mock('./actions', () => ({
  createCustomProgram: jest.fn(),
  updateCustomProgram: jest.fn(),
  switchProgram: jest.fn(),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));

const mockFetch = jest.mocked(fetchLiftModificationsByLift);
const mockUpdate = jest.mocked(updateCustomProgram);

const WIDE = { id: 'm-wide', lift: 'cable-curl', name: 'Wide grip', description: '', maxMode: 'none' as const, createdAt: '' };
const row = (week: number, modifications?: string[]) => ({
  week, offset: 0, order: 1, lift: 'Cable Curl', increment: 5, sets: 3, reps: 10, amrap: false,
  warmUpPct: '0.5', wtDecrementPct: 0, activation: '', ...(modifications && { modifications }),
});
const existing = (modifications?: string[]): CustomProgramResponse => ({
  id: 'p1', name: 'Mine', description: null, baseTemplate: null, createdAt: '',
  specs: [1, 2, 3].map((w) => row(w, modifications)),
});

function renderEdit(program: CustomProgramResponse) {
  render(
    <ProgramEditor mode="edit" existing={program} activeProgram={null} defaultWeightIncrement={null}
      onSaved={() => {}} onCancel={() => {}} />,
  );
}

describe('ProgramEditor — start-on modifications (#1155)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockResolvedValue(existing());
  });

  it('shows the slot’s start-on modification on, and saves it unchanged', async () => {
    mockFetch.mockResolvedValue({ 'Cable Curl': [WIDE] });
    renderEdit(existing(['m-wide']));

    const box = await screen.findByRole('checkbox', { name: 'Cable Curl #1 Day 1 starts with Wide grip' });
    expect(box).toBeChecked();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0]?.[1].specs?.map((r) => r.modifications)).toEqual([['m-wide'], ['m-wide'], ['m-wide']]);
  });

  it('saves a slot with its start-on turned on, and off', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({ 'Cable Curl': [WIDE] });
    renderEdit(existing());

    const box = await screen.findByRole('checkbox', { name: 'Cable Curl #1 Day 1 starts with Wide grip' });
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0]?.[1].specs?.[0]?.modifications).toEqual(['m-wide']);

    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate.mock.calls[1]?.[1].specs?.[0]?.modifications).toEqual([]);
  });

  it('asks only about the program’s lifts, not a complex slot', async () => {
    mockFetch.mockResolvedValue({ 'Cable Curl': [WIDE] });
    const program = existing();
    renderEdit({ ...program, specs: [...program.specs, ...[1, 2, 3].map((w) => ({ ...row(w), order: 2, lift: 'complex:c1' }))] });

    await screen.findByRole('checkbox', { name: 'Cable Curl #1 Day 1 starts with Wide grip' });
    expect(mockFetch).toHaveBeenCalledWith(['Cable Curl']);
  });

  // The fallback swallows the failed read: no boxes, and the saved list is sent back as it was,
  // so a failed read can't clear a slot's start-on (the success path is the first test).
  it('shows no boxes when the read fails, and still saves the slot’s list', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockRejectedValue(new Error('down'));
    renderEdit(existing(['m-wide']));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox', { name: /starts with/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0]?.[1].specs?.[0]?.modifications).toEqual(['m-wide']);
    error.mockRestore();
  });
});
