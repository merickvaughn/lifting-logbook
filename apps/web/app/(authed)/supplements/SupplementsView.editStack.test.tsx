import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STACK, dose, item } from '@/lib/__tests__/supplementsTestStack';
import type { Stack } from '@/lib/supplementsView';
import SupplementsView from './SupplementsView';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({
  updateSupplementItem: jest.fn(),
  createSupplementItem: jest.fn(),
  removeSupplementItem: jest.fn().mockResolvedValue({}),
  fetchSupplementCatalog: jest.fn().mockResolvedValue([]),
  moveSupplementDoses: jest.fn().mockResolvedValue({}),
  setSupplementStatus: jest.fn().mockResolvedValue({}),
  createSupplementMix: jest.fn().mockResolvedValue({}),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

import { createSupplementMix, moveSupplementDoses, removeSupplementItem, setSupplementStatus } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

const DATE = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The checkbox for an item's row; `slot` picks one row of an item that has several. */
const checkbox = (name: string, slot?: string) =>
  screen.getByRole('checkbox', { name: new RegExp(`^Select ${escape(name)}${slot ? `, ${escape(slot)}$` : '(, |$)'}`) });
const tick = (name: string, slot?: string) => userEvent.click(checkbox(name, slot));
const bar = () => screen.getByRole('region', { name: 'Selected items' });
const announcement = () => screen.getByTestId('supp-announcement');

async function enterEditMode(stack: Stack = STACK) {
  const view = render(<SupplementsView stack={stack} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
  return view;
}

beforeEach(() => jest.clearAllMocks());

describe('Edit stack mode', () => {
  it('swaps Edit stack for Done, shows the banner, and gives every row a checkbox and Edit', async () => {
    await enterEditMode();
    expect(screen.queryByRole('button', { name: 'Edit stack' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Editing: tap any item to change it, or tick several');
    expect(screen.getByRole('checkbox', { name: 'Select Nutricost Pre-X, Pre-workout' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Nutricost Pre-X' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Magnesium glycinate, Night' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit stack' })).toBeInTheDocument();
  });

  it('names the slot on each checkbox of an item with rows in two slots, and not on a pending row', async () => {
    await enterEditMode();
    expect(checkbox('Creatine monohydrate', 'Pre-workout')).toBeInTheDocument();
    expect(checkbox('Creatine monohydrate', 'Throughout the day')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Hydrolyzed collagen peptides' })).toBeInTheDocument();
  });

  it('opens the form, not the detail panel, when a row or its Edit button is tapped', async () => {
    await enterEditMode();
    await userEvent.click(screen.getAllByRole('button', { name: /Quest protein/ })[0]);
    expect(screen.getByRole('dialog', { name: 'Edit Quest protein (vanilla milkshake)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit Nutricost Pre-X' }));
    expect(screen.getByRole('dialog', { name: 'Edit Nutricost Pre-X' })).toBeInTheDocument();
  });

  it('Cancel on the form returns focus to the row’s Edit button, since no panel is open', async () => {
    await enterEditMode();
    const edit = screen.getByRole('button', { name: 'Edit Nutricost Pre-X' });
    await userEvent.click(edit);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(edit).toHaveFocus();
  });

  it('opens Pending, with a Start button on each pending row, and its toggle disabled', async () => {
    await enterEditMode();
    const pending = screen.getByRole('region', { name: 'Pending' });
    expect(within(pending).getByText('Hydrolyzed collagen peptides')).toBeInTheDocument();
    expect(within(pending).getByRole('button', { name: 'Start Hydrolyzed collagen peptides' })).toBeInTheDocument();
    expect(within(pending).getByRole('button', { name: /Pending · 1/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Start Nutricost Pre-X' })).toBeNull();
  });

  it('shows no bulk bar until a row is ticked, then counts the selection and Clear empties it', async () => {
    await enterEditMode();
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
    await tick('Nutricost Pre-X');
    await tick('Quest protein (vanilla milkshake)');
    expect(bar()).toHaveTextContent('2 selected');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
  });

  it('counts rows and items apart when one item has two rows selected', async () => {
    await enterEditMode();
    await tick('Creatine monohydrate', 'Pre-workout');
    await tick('Creatine monohydrate', 'Throughout the day');
    expect(bar()).toHaveTextContent('2 rows selected (1 item)');
  });

  it('unticks a row the day-type switch hides, so it isn’t acted on unseen', async () => {
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await tick('Fish oil');
    await userEvent.click(screen.getByRole('button', { name: 'Rest day' }));
    expect(bar()).toHaveTextContent('1 selected');
    await userEvent.click(screen.getByRole('button', { name: 'Lift day' }));
    expect(checkbox('Nutricost Pre-X')).not.toBeChecked();
    expect(bar()).toHaveTextContent('1 selected');
  });

  it('unticks a pending row once a refresh shows it started, so it isn’t ticked again if it goes back', async () => {
    const { rerender } = await enterEditMode();
    await tick('Hydrolyzed collagen peptides');
    await tick('Fish oil');
    const started: Stack = { ...STACK, items: STACK.items.map((i) => (i.id === 'collagen' ? { ...i, status: 'active' } : i)) };
    rerender(<SupplementsView stack={started} />);
    expect(checkbox('Hydrolyzed collagen peptides')).not.toBeChecked();
    expect(bar()).toHaveTextContent('1 selected');
    rerender(<SupplementsView stack={STACK} />);
    expect(checkbox('Hydrolyzed collagen peptides')).not.toBeChecked();
    expect(bar()).toHaveTextContent('1 selected');
  });
});

describe('bulk actions', () => {
  beforeEach(async () => {
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await tick('Quest protein (vanilla milkshake)');
  });

  it('Move to… names exactly the selected doses, in one request, to the chosen slot and day types', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move 2 rows' });
    expect(dialog).toHaveTextContent('Each selected row is one time an item is taken; only those times move.');
    await userEvent.selectOptions(within(dialog).getByLabelText('Slot'), 'am');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Rest day' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(moveSupplementDoses).toHaveBeenCalledTimes(1);
    expect(moveSupplementDoses).toHaveBeenCalledWith(
      {
        itemIds: ['pre-x', 'quest'],
        doses: [
          { itemId: 'pre-x', index: 0, slot: 'pre' },
          { itemId: 'quest', index: 0, slot: 'pre' },
        ],
        to: 'am',
        dayTypes: ['rest'],
      },
      DATE,
    );
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
    expect(announcement()).toHaveTextContent('Moved 2 rows.');
  });

  it('Move to… with no day type ticked means every day, and needs one for a workout slot', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(moveSupplementDoses).toHaveBeenCalledWith(expect.objectContaining({ to: 'pm', dayTypes: [] }), DATE);
    expect(moveSupplementDoses).toHaveBeenCalledTimes(1);
  });

  it('Move to… refuses a workout slot with no day type, without calling the API', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Slot'), 'post');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Pick at least one day type');
    expect(moveSupplementDoses).not.toHaveBeenCalled();
  });

  it('Cancel on a bulk dialog returns focus to the button that opened it', async () => {
    const move = within(bar()).getByRole('button', { name: 'Move to…' });
    await userEvent.click(move);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(move).toHaveFocus();
    expect(bar()).toHaveTextContent('2 selected');
  });

  it('Combine into mix… sends the name and the selected items, once the name is filled in', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Combine into mix…' }));
    const dialog = screen.getByRole('dialog', { name: 'Combine into a mix' });
    expect(dialog).toHaveTextContent('Nutricost Pre-X, Quest protein (vanilla milkshake) become one row');
    await userEvent.type(within(dialog).getByLabelText('Mix name'), 'Shake');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Combine' }));
    expect(createSupplementMix).toHaveBeenCalledWith('Shake', ['pre-x', 'quest'], DATE);
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(announcement()).toHaveTextContent('Combined 2 items into a mix.');
  });

  it('Combine into mix… refuses a name that is only spaces, without calling the API', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Combine into mix…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Mix name'), '   ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Combine' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the mix a name.');
    expect(createSupplementMix).not.toHaveBeenCalled();
  });

  it('Mark active and Mark pending send the distinct item ids with the status', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Mark pending' }));
    expect(setSupplementStatus).toHaveBeenLastCalledWith(['pre-x', 'quest'], 'pending', DATE);
    expect(announcement()).toHaveTextContent('Marked 2 items pending.');
    await tick('Nutricost Pre-X');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Mark active' }));
    expect(setSupplementStatus).toHaveBeenLastCalledWith(['pre-x'], 'active', DATE);
  });

  it('Remove asks twice, reading Tap again to remove N items, then removes each item', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    expect(removeSupplementItem).not.toHaveBeenCalled();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Tap again to remove 2 items' }));
    expect(removeSupplementItem).toHaveBeenCalledTimes(2);
    expect(removeSupplementItem).toHaveBeenCalledWith('pre-x', DATE);
    expect(removeSupplementItem).toHaveBeenCalledWith('quest', DATE);
    expect(announcement()).toHaveTextContent('Removed 2 items.');
  });

  it('Remove’s first tap is undone by Clear, and by changing the selection, even back to the same count', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    await tick('Quest protein (vanilla milkshake)');
    await tick('Fish oil');
    // Still two items, but not the two the first tap was for.
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    expect(removeSupplementItem).not.toHaveBeenCalled();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
    expect(removeSupplementItem).not.toHaveBeenCalled();
  });

  it('a double-click on Remove doesn’t confirm it', async () => {
    const remove = within(bar()).getByRole('button', { name: 'Remove' });
    fireEvent.click(remove, { detail: 1 });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Tap again to remove 2 items' }), { detail: 2 });
    expect(removeSupplementItem).not.toHaveBeenCalled();
  });
});

describe('Move to… on a stack', () => {
  it('moves one of two doses an item has in one slot, not both', async () => {
    // Pre-workout on lift days and on rest days: two doses in one slot, one row on each day.
    const stack: Stack = {
      ...STACK,
      items: [item('beta', 'Beta-alanine', { doses: [dose('pre', '3 g', ['lift']), dose('pre', '1.6 g', ['rest'])] })],
    };
    await enterEditMode(stack);
    await tick('Beta-alanine');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Move' }));
    expect(moveSupplementDoses).toHaveBeenCalledWith(
      { itemIds: ['beta'], doses: [{ itemId: 'beta', index: 0, slot: 'pre' }], to: 'pm', dayTypes: [] },
      DATE,
    );
  });

  it('with no day types offers only the daily slots, and says why', async () => {
    const stack: Stack = { ...STACK, dayTypes: [], items: [item('fish-oil', 'Fish oil', { doses: [dose('am', '1,000 mg')] })] };
    await enterEditMode(stack);
    await tick('Fish oil');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog');
    const options = within(within(dialog).getByLabelText('Slot')).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(options).toEqual(['all', 'am', 'noon', 'pm']);
    expect(within(dialog).queryByRole('group', { name: 'Day types' })).toBeNull();
    expect(dialog).toHaveTextContent('Add day types in Settings to move items into a workout slot.');
  });

  it('can’t be closed with × or Esc while the move is saving', async () => {
    let finish: (v: unknown) => void = () => undefined;
    (moveSupplementDoses as jest.Mock).mockReturnValueOnce(new Promise((r) => (finish = r)));
    await enterEditMode();
    await tick('Fish oil');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    const esc = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    finish({});
    await screen.findByText('Moved 1 row.');
  });
});

describe('Start', () => {
  it('moves a pending item to active in one tap, and moves focus to Done', async () => {
    await enterEditMode();
    await userEvent.click(screen.getByRole('button', { name: 'Start Hydrolyzed collagen peptides' }));
    expect(setSupplementStatus).toHaveBeenCalledWith(['collagen'], 'active', DATE);
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveFocus();
    expect(announcement()).toHaveTextContent('Started Hydrolyzed collagen peptides.');
  });
});

describe('a failed write', () => {
  it('Move keeps the selection and the dialog’s input, and reports the error', async () => {
    (moveSupplementDoses as jest.Mock).mockRejectedValueOnce(new Error('stale'));
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await tick('Quest protein (vanilla milkshake)');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Slot'), 'am');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Lift day' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(logClientError).toHaveBeenCalledWith('supplements.bulkMove', expect.any(Error), expect.objectContaining({ rows: 2, to: 'am' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Couldn’t move them. Nothing was changed');
    expect(within(dialog).getByLabelText('Slot')).toHaveValue('am');
    expect(within(dialog).getByRole('checkbox', { name: 'Lift day' })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
    expect(bar()).toHaveTextContent('2 selected');
  });

  it('Combine keeps the selection and the typed name, and reports the error', async () => {
    (createSupplementMix as jest.Mock).mockRejectedValueOnce(new Error('nope'));
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await tick('Quest protein (vanilla milkshake)');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Combine into mix…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Mix name'), 'Shake');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Combine' }));
    expect(logClientError).toHaveBeenCalledWith('supplements.combine', expect.any(Error), { items: 2 });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Couldn’t combine them');
    expect(within(dialog).getByLabelText('Mix name')).toHaveValue('Shake');
    expect(bar()).toHaveTextContent('2 selected');
  });

  it('Combine refuses a single item without calling the API', async () => {
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Combine into mix…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Mix name'), 'Shake');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Combine' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('two or more');
    expect(createSupplementMix).not.toHaveBeenCalled();
  });

  it('Combine refuses a mix among the selection without calling the API', async () => {
    const stack: Stack = {
      ...STACK,
      items: [
        item('broth', 'Broth', { parts: [], doses: [dose('am', '1 cup')] }),
        item('fish-oil', 'Fish oil', { doses: [dose('am', '1,000 mg')] }),
      ],
    };
    await enterEditMode(stack);
    await tick('Broth');
    await tick('Fish oil');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Combine into mix…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Mix name'), 'Shake');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Combine' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Broth is already a mix; split it first.');
    expect(createSupplementMix).not.toHaveBeenCalled();
  });

  it('Start reports the error and keeps the selection', async () => {
    (setSupplementStatus as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await userEvent.click(screen.getByRole('button', { name: 'Start Hydrolyzed collagen peptides' }));
    expect(logClientError).toHaveBeenCalledWith('supplements.start', expect.any(Error), { itemId: 'collagen' });
    expect(bar()).toHaveTextContent('1 selected');
    expect(within(bar()).getByRole('alert')).toHaveTextContent('Couldn’t save that');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Remove failure is logged, the selection kept, and the stack re-read since some can have gone', async () => {
    (removeSupplementItem as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Tap again to remove 1 item' }));
    expect(logClientError).toHaveBeenCalledWith('supplements.bulkRemove', expect.any(Error), { items: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(bar()).toHaveTextContent('1 selected');
  });

  it('a later success clears the error, and so does Clear', async () => {
    (setSupplementStatus as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Mark pending' }));
    expect(within(bar()).getByRole('alert')).toBeInTheDocument();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
    await tick('Nutricost Pre-X');
    (setSupplementStatus as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Mark pending' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Mark active' }));
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
  });
});
