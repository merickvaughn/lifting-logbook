import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STACK } from '@/lib/__tests__/supplementsTestStack';
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
const tick = (name: string) => userEvent.click(screen.getByRole('checkbox', { name: `Select ${name}` }));
const bar = () => screen.getByRole('region', { name: 'Selected items' });

async function enterEditMode() {
  render(<SupplementsView stack={STACK} />);
  await userEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
}

beforeEach(() => jest.clearAllMocks());

describe('Edit stack mode', () => {
  it('swaps Edit stack for Done, shows the banner, and gives every row a checkbox and Edit', async () => {
    await enterEditMode();
    expect(screen.queryByRole('button', { name: 'Edit stack' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Editing: tap any item to change it, or tick several');
    expect(screen.getByRole('checkbox', { name: 'Select Nutricost Pre-X' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Nutricost Pre-X' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Magnesium glycinate' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit stack' })).toBeInTheDocument();
  });

  it('opens the form, not the detail panel, when a row or its Edit button is tapped', async () => {
    await enterEditMode();
    await userEvent.click(screen.getAllByRole('button', { name: /Quest protein/ })[0]);
    expect(screen.getByRole('dialog', { name: 'Edit Quest protein (vanilla milkshake)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit Nutricost Pre-X' }));
    expect(screen.getByRole('dialog', { name: 'Edit Nutricost Pre-X' })).toBeInTheDocument();
  });

  it('opens Pending, with a Start button on each pending row', async () => {
    await enterEditMode();
    const pending = screen.getByRole('region', { name: 'Pending' });
    expect(within(pending).getByText('Hydrolyzed collagen peptides')).toBeInTheDocument();
    expect(within(pending).getByRole('button', { name: 'Start Hydrolyzed collagen peptides' })).toBeInTheDocument();
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
});

describe('bulk actions', () => {
  beforeEach(async () => {
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await tick('Quest protein (vanilla milkshake)');
  });

  it('Move to… moves only the selected doses: their slot, to the chosen slot and day types', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move 2 rows' });
    expect(dialog).toHaveTextContent('Each selected row is one time an item is taken; only those times move.');
    await userEvent.selectOptions(within(dialog).getByLabelText('Slot'), 'am');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Rest day' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(moveSupplementDoses).toHaveBeenCalledTimes(1);
    expect(moveSupplementDoses).toHaveBeenCalledWith({ itemIds: ['pre-x', 'quest'], from: 'pre', to: 'am', dayTypes: ['rest'] }, DATE);
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
  });

  it('Move to… with no day type ticked means every day, and needs one for a workout slot', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Move to…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(moveSupplementDoses).toHaveBeenCalledWith({ itemIds: ['pre-x', 'quest'], from: 'pre', to: 'pm', dayTypes: [] }, DATE);
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

  it('Combine into mix… sends the name and the selected items, once the name is filled in', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Combine into mix…' }));
    const dialog = screen.getByRole('dialog', { name: 'Combine into a mix' });
    expect(dialog).toHaveTextContent('Nutricost Pre-X, Quest protein (vanilla milkshake) become one row');
    await userEvent.type(within(dialog).getByLabelText('Mix name'), 'Shake');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Combine' }));
    expect(createSupplementMix).toHaveBeenCalledWith('Shake', ['pre-x', 'quest'], DATE);
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Mark active and Mark pending send the distinct item ids with the status', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Mark pending' }));
    expect(setSupplementStatus).toHaveBeenLastCalledWith(['pre-x', 'quest'], 'pending', DATE);
    await tick('Nutricost Pre-X');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Mark active' }));
    expect(setSupplementStatus).toHaveBeenLastCalledWith(['pre-x'], 'active', DATE);
  });

  it('Remove asks twice, reading Tap again to remove N, then removes each item', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    expect(removeSupplementItem).not.toHaveBeenCalled();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Tap again to remove 2' }));
    expect(removeSupplementItem).toHaveBeenCalledTimes(2);
    expect(removeSupplementItem).toHaveBeenCalledWith('pre-x', DATE);
    expect(removeSupplementItem).toHaveBeenCalledWith('quest', DATE);
  });

  it('Remove’s first tap is undone by Clear, and by changing the selection', async () => {
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    await tick('Quest protein (vanilla milkshake)');
    expect(within(bar()).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Selected items' })).toBeNull();
    expect(removeSupplementItem).not.toHaveBeenCalled();
  });
});

describe('Start', () => {
  it('moves a pending item to active in one tap', async () => {
    await enterEditMode();
    await userEvent.click(screen.getByRole('button', { name: 'Start Hydrolyzed collagen peptides' }));
    expect(setSupplementStatus).toHaveBeenCalledWith(['collagen'], 'active', DATE);
    expect(refresh).toHaveBeenCalled();
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
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Couldn’t move them');
    expect(within(dialog).getByLabelText('Slot')).toHaveValue('am');
    expect(within(dialog).getByRole('checkbox', { name: 'Lift day' })).toBeChecked();
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

  it('Remove failure is logged and the selection kept', async () => {
    (removeSupplementItem as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await enterEditMode();
    await tick('Nutricost Pre-X');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Tap again to remove 1' }));
    expect(logClientError).toHaveBeenCalledWith('supplements.bulkRemove', expect.any(Error), { items: 1 });
    expect(bar()).toHaveTextContent('1 selected');
  });
});
