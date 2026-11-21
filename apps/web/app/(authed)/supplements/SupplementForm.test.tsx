import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupplementCatalogEntry, SupplementItem } from '@lifting-logbook/types';
import { STACK } from '@/lib/__tests__/supplementsTestStack';
import SupplementForm, { type FormMode } from './SupplementForm';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({
  createSupplementItem: jest.fn(),
  updateSupplementItem: jest.fn(),
  removeSupplementItem: jest.fn(),
  fetchSupplementCatalog: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/calendarDay', () => ({ localToday: () => '2026-11-21' }));

import { createSupplementItem, fetchSupplementCatalog, removeSupplementItem, updateSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

const CREATINE: SupplementCatalogEntry = {
  key: 'creatine-monohydrate',
  name: 'Creatine monohydrate',
  aliases: ['creatine'],
  kind: 'compound',
  keyCompound: 'Creatine monohydrate',
  suggestedDose: '5 g',
  timing: 'Anytime or pre-workout',
  suggestedSlot: 'am',
  ingredients: [{ key: 'creatine', amount: 5, unit: 'g' }],
  reference: { uses: [], evidence: { level: 'strong', reason: 'r' }, cautions: [], typicalRange: '3-5 g', sources: [] },
};

const setup = (mode: FormMode) => {
  const onCancel = jest.fn();
  const onDismiss = jest.fn();
  render(<SupplementForm stack={STACK} mode={mode} dayTypeId="lift" onCancel={onCancel} onDismiss={onDismiss} />);
  return { onCancel, onDismiss, dialog: screen.getByRole('dialog') };
};
const add = (preset: 'workout' | 'daily' | 'pending') => setup({ kind: 'add', preset });
const editItem = (id: string) => setup({ kind: 'edit', item: STACK.items.find((i) => i.id === id) as SupplementItem });
const field = (name: RegExp | string) => screen.getByLabelText(name);

beforeEach(() => {
  jest.clearAllMocks();
  (fetchSupplementCatalog as jest.Mock).mockResolvedValue([]);
});

describe('presets by entry point', () => {
  it('+ Add to this day: a pre-workout dose on the shown day type, active, name focused', () => {
    add('workout');
    expect(screen.getByRole('heading', { name: 'Add supplement' })).toBeInTheDocument();
    expect(field('Name')).toHaveFocus();
    expect(field(/^Slot/)).toHaveValue('pre');
    expect(field('Servings')).toHaveValue(1);
    expect(screen.getByRole('checkbox', { name: 'Lift day' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Rest day' })).not.toBeChecked();
    expect(screen.getByText('Pick at least one.')).toBeInTheDocument();
    expect(field('Status')).toHaveValue('active');
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('+ Add daily item: every day morning, no day type ticked, active', () => {
    add('daily');
    expect(field(/^Slot/)).toHaveValue('am');
    expect(screen.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText('None ticked = every day.')).toBeInTheDocument();
    expect(field('Status')).toHaveValue('active');
  });

  it('+ Add a pending item: the daily preset with status Pending', () => {
    add('pending');
    expect(field(/^Slot/)).toHaveValue('am');
    expect(field('Status')).toHaveValue('pending');
  });

  it('Edit: titled for the item, filled from it, with Save and Remove', () => {
    editItem('pre-x');
    expect(screen.getByRole('heading', { name: 'Edit Nutricost Pre-X' })).toBeInTheDocument();
    expect(field('Name')).toHaveValue('Nutricost Pre-X');
    expect(field('Timing')).toHaveValue('30–60 min before');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('+ Add another time appends a workout row and focuses its amount; the first row can’t be removed alone', async () => {
    add('workout');
    expect(screen.getByRole('button', { name: 'Remove dose 1' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '+ Add another time' }));
    expect(screen.getAllByLabelText(/^Amount/)[1]).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Remove dose 1' })).toBeEnabled();
  });

  it('limits the short note to 80 characters', () => {
    add('daily');
    expect(field(/^Short note/)).toHaveAttribute('maxlength', '80');
  });
});

describe('catalog autofill', () => {
  it('fills the empty fields, tags them SUGGESTED, shows the banner and a store-search link row', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([CREATINE]);
    const { dialog } = add('workout');
    await userEvent.type(field('Name'), 'creatine');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Filled 6 fields from the shared catalog; label facts, uses and sources will be attached. Blue fields are suggestions; change anything.',
    );
    expect(field('Name')).toHaveValue('creatine');
    expect(field(/^Key compound/)).toHaveValue('Creatine monohydrate');
    expect(field(/^Slot/)).toHaveValue('am');
    expect(field(/^Amount/)).toHaveValue('5 g');
    expect(field(/^Typical range/)).toHaveValue('3–5 g'.replace('–', '-'));
    expect(field(/^Timing/)).toHaveValue('Anytime or pre-workout');
    expect(within(dialog).getAllByText('SUGGESTED')).toHaveLength(6);
    expect(screen.getByLabelText('Link 1 label')).toHaveValue('Search Amazon');
    expect(screen.getByLabelText('Link 1 URL')).toHaveValue('https://www.amazon.com/s?k=creatine');
  });

  it('keeps what the lifter typed when a catalog match arrives later', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([CREATINE]);
    add('workout');
    await userEvent.type(field(/^Amount/), '2 scoops');
    await userEvent.selectOptions(field(/^Slot/), 'post');
    await userEvent.type(field(/^Timing/), 'with food');
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    expect(field(/^Amount/)).toHaveValue('2 scoops');
    expect(field(/^Slot/)).toHaveValue('post');
    expect(field(/^Timing/)).toHaveValue('with food');
    expect(field(/^Key compound/)).toHaveValue('Creatine monohydrate');
    expect(screen.getByRole('status')).toHaveTextContent('Filled 3 fields');
  });

  it('tracks the name in the suggested link until the lifter edits it', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([CREATINE]);
    add('daily');
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    await userEvent.type(field('Name'), ' hcl');
    expect(screen.getByLabelText('Link 1 URL')).toHaveValue('https://www.amazon.com/s?k=creatine%20hcl');
    await userEvent.type(screen.getByLabelText('Link 1 label'), '!');
    await userEvent.type(field('Name'), ' x');
    expect(screen.getByLabelText('Link 1 URL')).toHaveValue('https://www.amazon.com/s?k=creatine%20hcl');
  });

  it('says a name with no match is not in the shared catalog, and fills nothing', async () => {
    add('daily');
    await userEvent.type(field('Name'), 'mag');
    expect(await screen.findByText('Not in the shared catalog.')).toBeInTheDocument();
    expect(field(/^Key compound/)).toHaveValue('');
    expect(screen.queryByText('SUGGESTED')).toBeNull();
  });

  it('on an edit, fills only empty fields and never re-slots', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([{ ...CREATINE, suggestedSlot: 'pm' }]);
    editItem('glycine');
    // Glycine already has a key compound, timing and slot; its dose has no amount.
    await userEvent.clear(field('Name'));
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    expect(field(/^Amount/)).toHaveValue('5 g');
    expect(field(/^Slot/)).toHaveValue('am');
    expect(field(/^Key compound/)).toHaveValue('Glycine');
    expect(field(/^Timing/)).toHaveValue('With food');
    expect(screen.getByRole('status')).toHaveTextContent('Filled 3 fields');
    expect(screen.getByRole('status')).not.toHaveTextContent('label facts');
  });
});

describe('saving', () => {
  it('adds through the API with the catalog key, then refreshes and closes', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([CREATINE]);
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    const { onDismiss } = add('daily');
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(createSupplementItem).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'creatine',
        catalogKey: 'creatine-monohydrate',
        status: 'active',
        doses: [{ slot: 'am', amount: '5 g', servings: 1, dayTypes: [] }],
        links: [{ label: 'Search Amazon', url: 'https://www.amazon.com/s?k=creatine' }],
      }),
      '2026-11-21',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('sends protein per serving as an ingredient, and category, on an add', async () => {
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    add('daily');
    await userEvent.type(field('Name'), 'Whey');
    await userEvent.type(field(/^Protein/), '24');
    await userEvent.type(field(/^Category/), 'Recovery');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createSupplementItem).toHaveBeenCalled());
    expect(createSupplementItem).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Recovery', ingredients: [{ key: 'protein', amount: 24, unit: 'g' }] }),
      '2026-11-21',
    );
  });

  it('won’t send a workout dose with no day type', async () => {
    add('workout');
    await userEvent.type(field('Name'), 'X');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Lift day' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one day type');
    expect(createSupplementItem).not.toHaveBeenCalled();
  });

  it('saves an edit with PATCH, then closes everything', async () => {
    (updateSupplementItem as jest.Mock).mockResolvedValue({});
    const { onDismiss } = editItem('glycine');
    await userEvent.type(field(/^Category/), 'Sleep');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(updateSupplementItem).toHaveBeenCalledWith('glycine', expect.objectContaining({ name: 'Glycine', category: 'Sleep' }), '2026-11-21');
    expect(refresh).toHaveBeenCalled();
  });

  it('Remove asks again, then removes', async () => {
    (removeSupplementItem as jest.Mock).mockResolvedValue({});
    const { onDismiss } = editItem('glycine');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(removeSupplementItem).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Tap again to remove' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(removeSupplementItem).toHaveBeenCalledWith('glycine', '2026-11-21');
  });

  it('Cancel goes back, × closes everything', async () => {
    const { onCancel, onDismiss } = editItem('glycine');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('write failures', () => {
  const boom = new Error('API 500');

  it('add: logs, says so, and keeps the input', async () => {
    (createSupplementItem as jest.Mock).mockRejectedValue(boom);
    const { onDismiss } = add('daily');
    await userEvent.type(field('Name'), 'Whey');
    await userEvent.type(field(/^Short note/), 'in milk');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t add');
    expect(logClientError).toHaveBeenCalledWith('supplements.addItem', boom, undefined);
    expect(field('Name')).toHaveValue('Whey');
    expect(field(/^Short note/)).toHaveValue('in milk');
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('edit: logs, says so, and keeps the input', async () => {
    (updateSupplementItem as jest.Mock).mockRejectedValue(boom);
    const { onDismiss } = editItem('glycine');
    await userEvent.type(field(/^Category/), 'Sleep');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save');
    expect(logClientError).toHaveBeenCalledWith('supplements.editItem', boom, { itemId: 'glycine' });
    expect(field(/^Category/)).toHaveValue('Sleep');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('remove: logs, says so, and keeps the form', async () => {
    (removeSupplementItem as jest.Mock).mockRejectedValue(boom);
    const { onDismiss } = editItem('glycine');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tap again to remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t remove');
    expect(logClientError).toHaveBeenCalledWith('supplements.removeItem', boom, { itemId: 'glycine' });
    expect(field('Name')).toHaveValue('Glycine');
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
