import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BarbellComplexResponse } from '@lifting-logbook/types';
import { createBarbellComplex, deleteBarbellComplex, updateBarbellComplex } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import ComplexesEditor from './ComplexesEditor';

jest.mock('@/lib/client-api', () => ({
  createBarbellComplex: jest.fn(),
  updateBarbellComplex: jest.fn(),
  deleteBarbellComplex: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const BEAR: BarbellComplexResponse = {
  id: 'c-bear',
  name: 'Bear',
  components: [
    { lift: 'Deadlift', reps: 5, name: 'Deadlift' },
    { lift: 'Front Squat', reps: 5, name: 'Front Squat' },
  ],
  createdAt: '2026-11-27T00:00:00.000Z',
};

const HANG_CLEAN = { id: 'custom-1', name: 'Hang Clean' };

beforeEach(() => jest.clearAllMocks());

describe('ComplexesEditor (#1495)', () => {
  it('creates a complex from the lifter’s lifts, sending a custom lift by its id, and lists it', async () => {
    const user = userEvent.setup();
    const created: BarbellComplexResponse = {
      id: 'c-new',
      name: 'Morning',
      components: [
        { lift: 'custom-1', reps: 3, name: 'Hang Clean' },
        { lift: 'Front Squat', reps: 4, name: 'Front Squat' },
      ],
      createdAt: '2026-11-27T00:00:00.000Z',
    };
    jest.mocked(createBarbellComplex).mockResolvedValue({ ok: true, data: created });
    render(<ComplexesEditor initialComplexes={[]} customLifts={[HANG_CLEAN]} />);

    expect(screen.getByText('No complexes yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New complex' }));
    await user.type(screen.getByLabelText('Complex name'), 'Morning');
    await user.selectOptions(screen.getByLabelText('Lift 1'), 'Hang Clean');
    await user.clear(screen.getByLabelText('Reps 1'));
    await user.type(screen.getByLabelText('Reps 1'), '3');
    await user.selectOptions(screen.getByLabelText('Lift 2'), 'Front Squat');
    await user.clear(screen.getByLabelText('Reps 2'));
    await user.type(screen.getByLabelText('Reps 2'), '4');
    await user.click(screen.getByRole('button', { name: 'Save complex' }));

    await waitFor(() =>
      expect(createBarbellComplex).toHaveBeenCalledWith({
        name: 'Morning',
        components: [
          { lift: 'custom-1', reps: 3 },
          { lift: 'Front Squat', reps: 4 },
        ],
      }),
    );
    const list = within(await screen.findByRole('list', { name: 'Your complexes' }));
    expect(list.getByText('Morning')).toBeInTheDocument();
    expect(list.getByText('Hang Clean × 3 → Front Squat × 4')).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('edits a complex: renames it, adds a lift, and shows the saved version', async () => {
    const user = userEvent.setup();
    const saved: BarbellComplexResponse = {
      ...BEAR,
      name: 'Big Bear',
      components: [...BEAR.components, { lift: 'Push Press', reps: 2, name: 'Push Press' }],
    };
    jest.mocked(updateBarbellComplex).mockResolvedValue({ ok: true, data: saved });
    render(<ComplexesEditor initialComplexes={[BEAR]} customLifts={[]} />);

    await user.click(screen.getByRole('button', { name: 'Edit Bear' }));
    expect(screen.getByLabelText('Lift 1')).toHaveValue('Deadlift');
    await user.clear(screen.getByLabelText('Complex name'));
    await user.type(screen.getByLabelText('Complex name'), 'Big Bear');
    await user.click(screen.getByRole('button', { name: 'Add lift' }));
    await user.selectOptions(screen.getByLabelText('Lift 3'), 'Push Press');
    await user.clear(screen.getByLabelText('Reps 3'));
    await user.type(screen.getByLabelText('Reps 3'), '2');
    await user.click(screen.getByRole('button', { name: 'Save complex' }));

    await waitFor(() =>
      expect(updateBarbellComplex).toHaveBeenCalledWith('c-bear', {
        name: 'Big Bear',
        components: saved.components.map(({ lift, reps }) => ({ lift, reps })),
      }),
    );
    expect(await screen.findByText('Big Bear')).toBeInTheDocument();
    expect(screen.queryByText('Bear', { exact: true })).not.toBeInTheDocument();
  });

  it('flags a lift that is no longer a lift, and still sends it as stored', async () => {
    const user = userEvent.setup();
    const stale: BarbellComplexResponse = {
      ...BEAR,
      components: [
        { lift: 'custom-gone', reps: 3, name: 'Deleted lift' },
        { lift: 'Front Squat', reps: 5, name: 'Front Squat' },
      ],
    };
    jest.mocked(updateBarbellComplex).mockResolvedValue({ ok: true, data: { ...stale, name: 'Old bear' } });
    render(<ComplexesEditor initialComplexes={[stale]} customLifts={[]} />);

    await user.click(screen.getByRole('button', { name: 'Edit Bear' }));
    expect(screen.getByLabelText('Lift 1')).toHaveDisplayValue('Deleted lift (no longer a lift)');
    await user.clear(screen.getByLabelText('Complex name'));
    await user.type(screen.getByLabelText('Complex name'), 'Old bear');
    await user.click(screen.getByRole('button', { name: 'Save complex' }));

    await waitFor(() =>
      expect(updateBarbellComplex).toHaveBeenCalledWith('c-bear', {
        name: 'Old bear',
        components: [
          { lift: 'custom-gone', reps: 3 },
          { lift: 'Front Squat', reps: 5 },
        ],
      }),
    );
  });

  it('deletes a complex once confirmed', async () => {
    const user = userEvent.setup();
    jest.mocked(deleteBarbellComplex).mockResolvedValue(undefined);
    render(<ComplexesEditor initialComplexes={[BEAR]} customLifts={[]} />);

    await user.click(screen.getByRole('button', { name: 'Delete Bear' }));
    expect(deleteBarbellComplex).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Yes, delete Bear' }));

    await waitFor(() => expect(deleteBarbellComplex).toHaveBeenCalledWith('c-bear'));
    expect(await screen.findByText('No complexes yet.')).toBeInTheDocument();
  });

  it('shows a name clash from the API on the name field and keeps the form open', async () => {
    const user = userEvent.setup();
    jest
      .mocked(createBarbellComplex)
      .mockResolvedValue({ ok: false, conflictMessage: 'You already have a complex named "Bear"' });
    render(<ComplexesEditor initialComplexes={[BEAR]} customLifts={[]} />);

    await user.click(screen.getByRole('button', { name: 'New complex' }));
    await user.type(screen.getByLabelText('Complex name'), 'Bear');
    await user.selectOptions(screen.getByLabelText('Lift 1'), 'Deadlift');
    await user.selectOptions(screen.getByLabelText('Lift 2'), 'Front Squat');
    await user.click(screen.getByRole('button', { name: 'Save complex' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You already have a complex named "Bear"');
    expect(screen.getByLabelText('Complex name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Complex name')).toHaveAccessibleDescription('You already have a complex named "Bear"');
    expect(screen.getByLabelText('Complex name')).toHaveFocus();
  });

  it('refuses a complex with an unchosen lift before sending it, pointing at that lift', async () => {
    const user = userEvent.setup();
    render(<ComplexesEditor initialComplexes={[]} customLifts={[]} />);
    await user.click(screen.getByRole('button', { name: 'New complex' }));
    await user.type(screen.getByLabelText('Complex name'), 'Half');
    await user.selectOptions(screen.getByLabelText('Lift 1'), 'Deadlift');
    await user.click(screen.getByRole('button', { name: 'Save complex' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Choose lift 2.');
    expect(screen.getByLabelText('Lift 2')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Lift 2')).toHaveAccessibleDescription('Choose lift 2.');
    expect(screen.getByLabelText('Lift 2')).toHaveFocus();
    expect(screen.getByLabelText('Lift 1')).not.toHaveAttribute('aria-invalid');
    expect(createBarbellComplex).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove lift 1' })).toBeDisabled();
  });

  it('logs a failed delete and says so', async () => {
    const user = userEvent.setup();
    const err = new Error('network');
    jest.mocked(deleteBarbellComplex).mockRejectedValue(err);
    render(<ComplexesEditor initialComplexes={[BEAR]} customLifts={[]} />);

    await user.click(screen.getByRole('button', { name: 'Delete Bear' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete Bear' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t delete the complex. Try again.');
    expect(logClientError).toHaveBeenCalledWith('deleteBarbellComplex', err, { complexId: 'c-bear' });
    expect(screen.getByText('Bear')).toBeInTheDocument();
  });

  describe('focus', () => {
    it('moves to the name when the form opens, and back to New complex on cancel and on save', async () => {
      const user = userEvent.setup();
      jest.mocked(updateBarbellComplex).mockResolvedValue({ ok: true, data: BEAR });
      render(<ComplexesEditor initialComplexes={[BEAR]} customLifts={[]} />);

      await user.click(screen.getByRole('button', { name: 'New complex' }));
      expect(screen.getByLabelText('Complex name')).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: 'New complex' })).toHaveFocus();

      await user.click(screen.getByRole('button', { name: 'Edit Bear' }));
      expect(screen.getByLabelText('Complex name')).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Save complex' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'New complex' })).toHaveFocus());
    });

    it('moves to the confirm button when Delete asks, back to Delete on Keep it, and to New complex once deleted', async () => {
      const user = userEvent.setup();
      jest.mocked(deleteBarbellComplex).mockResolvedValue(undefined);
      render(<ComplexesEditor initialComplexes={[BEAR]} customLifts={[]} />);

      await user.click(screen.getByRole('button', { name: 'Delete Bear' }));
      expect(screen.getByRole('button', { name: 'Yes, delete Bear' })).toHaveFocus();
      await user.click(screen.getByRole('button', { name: 'Keep it' }));
      expect(screen.getByRole('button', { name: 'Delete Bear' })).toHaveFocus();

      await user.click(screen.getByRole('button', { name: 'Delete Bear' }));
      await user.click(screen.getByRole('button', { name: 'Yes, delete Bear' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'New complex' })).toHaveFocus());
    });
  });
});
