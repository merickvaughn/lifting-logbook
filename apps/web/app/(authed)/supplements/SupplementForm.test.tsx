import { act, render, screen, waitFor, within } from '@testing-library/react';
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
  removeSupplementItems: jest.fn(),
  setSupplementStatus: jest.fn(),
  fetchSupplementCatalog: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/calendarDay', () => ({ localToday: () => '2026-11-21' }));

import {
  createSupplementItem,
  fetchSupplementCatalog,
  removeSupplementItem,
  removeSupplementItems,
  setSupplementStatus,
  updateSupplementItem,
} from '@/lib/client-api';
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
    expect(field(/^Typical range/)).toHaveValue('3-5 g');
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

  it('drops a field’s SUGGESTED tag once the lifter changes it', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([CREATINE]);
    const { dialog } = add('workout');
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    await userEvent.type(field(/^Timing/), '!');
    expect(within(dialog).getAllByText('SUGGESTED')).toHaveLength(5);
    expect(field(/^Timing/).closest('label')).not.toHaveTextContent('SUGGESTED');
  });

  it('re-slotting into a workout slot ticks the shown day type, so the form can still be saved', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([{ ...CREATINE, suggestedSlot: 'post' }]);
    add('daily');
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    expect(field(/^Slot/)).toHaveValue('post');
    expect(screen.getByRole('checkbox', { name: 'Lift day' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Rest day' })).not.toBeChecked();
  });

  it('looks a name up once, however often the lifter comes back to it', async () => {
    (fetchSupplementCatalog as jest.Mock).mockImplementation(async (q: string) => (q === 'creatine' ? [CREATINE] : []));
    add('daily');
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByText(/^Filled/);
    await userEvent.type(field('Name'), 'x');
    await screen.findByText('Not in the shared catalog.');
    await userEvent.type(field('Name'), '{Backspace}');
    // Wait out the lookup delay, so a second request would have been made by now.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect((fetchSupplementCatalog as jest.Mock).mock.calls.filter(([q]) => q === 'creatine')).toHaveLength(1);
  });

  it('reports a failed lookup once, shows no suggestion, and still saves', async () => {
    (fetchSupplementCatalog as jest.Mock).mockRejectedValue(new Error('API 503'));
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    add('daily');
    await userEvent.type(field('Name'), 'creatine');
    await waitFor(() => expect(logClientError).toHaveBeenCalledWith('supplements.catalogLookup', expect.any(Error)));
    expect(logClientError).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('SUGGESTED')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createSupplementItem).toHaveBeenCalled());
    expect((createSupplementItem as jest.Mock).mock.calls[0][0]).toMatchObject({ name: 'creatine', keyCompound: '' });
    expect((createSupplementItem as jest.Mock).mock.calls[0][0]).not.toHaveProperty('catalogKey');
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

  it('an edit never sends a catalog key, even after a name that matches the catalog', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([CREATINE]);
    (updateSupplementItem as jest.Mock).mockResolvedValue({});
    const { onDismiss } = editItem('glycine');
    await userEvent.clear(field('Name'));
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect((updateSupplementItem as jest.Mock).mock.calls[0][1]).toMatchObject({ name: 'creatine' });
    expect((updateSupplementItem as jest.Mock).mock.calls[0][1]).not.toHaveProperty('catalogKey');
  });

  it('doesn’t save a match made for an earlier name', async () => {
    // The lookup for the new name never answers, so only the old match could be sent.
    (fetchSupplementCatalog as jest.Mock).mockImplementation((q: string) => (q === 'creatine' ? Promise.resolve([CREATINE]) : new Promise(() => {})));
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    add('daily');
    await userEvent.type(field('Name'), 'creatine');
    await screen.findByRole('status');
    await userEvent.type(field('Name'), ' blend');
    expect(screen.queryByRole('status')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createSupplementItem).toHaveBeenCalled());
    expect((createSupplementItem as jest.Mock).mock.calls[0][0]).toMatchObject({ name: 'creatine blend' });
    expect((createSupplementItem as jest.Mock).mock.calls[0][0]).not.toHaveProperty('catalogKey');
  });

  it('a mix’s protein comes from its parts, so it can’t be edited', () => {
    const glycine = STACK.items.find((i) => i.id === 'glycine') as SupplementItem;
    setup({ kind: 'edit', item: { ...glycine, parts: [{ itemId: 'a', name: 'A', ingredients: [] }] } });
    expect(field(/^Protein/)).toBeDisabled();
    expect(screen.getByText('(from its parts)')).toBeInTheDocument();
  });

  it('on an add, a blank protein keeps the catalog entry’s ingredients', async () => {
    const whey = { ...CREATINE, key: 'whey', name: 'Whey', aliases: [], ingredients: [{ key: 'protein', amount: 25, unit: 'g' as const }] };
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([whey]);
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    add('daily');
    await userEvent.type(field('Name'), 'whey');
    await screen.findByRole('status');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createSupplementItem).toHaveBeenCalledTimes(1));
    expect((createSupplementItem as jest.Mock).mock.calls[0][0]).not.toHaveProperty('ingredients');
  });

  it('a typed 0 protein on an add sends no protein', async () => {
    const whey = { ...CREATINE, key: 'whey', name: 'Whey', aliases: [], ingredients: [{ key: 'protein', amount: 25, unit: 'g' as const }] };
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([whey]);
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    add('daily');
    await userEvent.type(field('Name'), 'whey');
    await screen.findByRole('status');
    await userEvent.type(field(/^Protein/), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createSupplementItem).toHaveBeenCalled());
    expect((createSupplementItem as jest.Mock).mock.calls[0][0]).toMatchObject({ ingredients: [] });
  });

  it.each([
    ['a host with no dot', 'https://localhost/x'],
    ['a space', 'https://example.com/my product'],
  ])('won’t send a product link with %s, which the API refuses', async (_what, url) => {
    add('daily');
    await userEvent.type(field('Name'), 'X');
    await userEvent.click(screen.getByRole('button', { name: '+ Add link' }));
    await userEvent.type(screen.getByLabelText('Link 1 URL'), url);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('A product link must be a web address');
    expect(createSupplementItem).not.toHaveBeenCalled();
  });

  it('caps each field at what the API takes', () => {
    add('daily');
    expect(field(/^Category/)).toHaveAttribute('maxLength', '200');
    expect(field(/^Typical range/)).toHaveAttribute('maxLength', '200');
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

describe('Replace with… (#1411)', () => {
  const caffeine = (amount: number): SupplementCatalogEntry => ({
    ...CREATINE,
    key: 'caffeine',
    name: 'Caffeine',
    aliases: [],
    suggestedSlot: 'pre',
    ingredients: [{ key: 'caffeine', amount, unit: 'mg' }],
  });
  const replace = (id: string) => setup({ kind: 'replace', item: STACK.items.find((i) => i.id === id) as SupplementItem });
  const typeName = async (name: string) => {
    await userEvent.click(field('Name'));
    await userEvent.paste(name);
    await screen.findByText(/Filled \d+ fields? from the shared catalog/);
  };
  const group = () => screen.getByRole('group', { name: 'Replace what you already take?' });
  const row = (name: string) => within(group()).getByRole('checkbox', { name: new RegExp(`^${name}`) });

  beforeEach(() => {
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    (setSupplementStatus as jest.Mock).mockResolvedValue({});
    (removeSupplementItems as jest.Mock).mockResolvedValue({});
  });

  it('opens the Add form on the item’s first dose slot and day types, listing the item being replaced', () => {
    replace('pre-x');
    expect(screen.getByRole('heading', { name: 'Add supplement' })).toBeInTheDocument();
    expect(field(/^Slot/)).toHaveValue('pre');
    expect(screen.getByRole('checkbox', { name: 'Lift day' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Rest day' })).not.toBeChecked();
    expect(row('Nutricost Pre-X')).toBeChecked();
    expect(within(group()).getByText('SAME SLOT')).toBeInTheDocument();
    expect(within(group()).getByText('You chose to replace this')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Move them to Pending/ })).toBeChecked();
  });

  it('pre-selects only same-slot overlaps it supplies at least as much of, same-slot ones first', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(400)]);
    add('workout');
    // No match yet, nothing shared: no group.
    expect(screen.queryByRole('group', { name: 'Replace what you already take?' })).not.toBeInTheDocument();
    await typeName('Caffeine');
    const boxes = within(group()).getAllByRole('checkbox');
    expect(boxes.map((b) => b.closest('label')?.querySelector('strong')?.textContent)).toEqual(['Nutricost Pre-X', 'EVL Trans4orm']);
    expect(row('Nutricost Pre-X')).toBeChecked();
    expect(row('EVL Trans4orm')).not.toBeChecked();
    expect(within(group()).getAllByText('SAME SLOT')).toHaveLength(1);
    expect(within(group()).getByText('Shares caffeine (300 mg now; 400 mg in this)')).toBeInTheDocument();
  });

  it('leaves a same-slot overlap unticked when it supplies less than the stack already has', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(100)]);
    add('workout');
    await typeName('Caffeine');
    expect(row('Nutricost Pre-X')).not.toBeChecked();
    expect(within(group()).getAllByText('SAME SLOT')).toHaveLength(1);
  });

  it('Move them to Pending (the default) adds, then marks the ticked items pending', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(400)]);
    const { onDismiss } = replace('pre-x');
    await typeName('Caffeine');
    await userEvent.click(row('EVL Trans4orm'));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(createSupplementItem).toHaveBeenCalledTimes(1);
    expect(setSupplementStatus).toHaveBeenCalledWith(['pre-x', 'trans4orm'], 'pending', '2026-11-21');
    expect(removeSupplementItems).not.toHaveBeenCalled();
  });

  it('Remove them removes the ticked item instead', async () => {
    const { onDismiss } = replace('pre-x');
    await userEvent.click(screen.getByRole('radio', { name: /Remove them/ }));
    await userEvent.click(field('Name'));
    await userEvent.paste('Pre-Y');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(removeSupplementItems).toHaveBeenCalledWith(['pre-x'], '2026-11-21');
    expect(removeSupplementItem).not.toHaveBeenCalled();
    expect(setSupplementStatus).not.toHaveBeenCalled();
  });

  it('an untick keeps the item out of the replacement', async () => {
    const { onDismiss } = replace('pre-x');
    await userEvent.click(row('Nutricost Pre-X'));
    await userEvent.click(field('Name'));
    await userEvent.paste('Pre-Y');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(setSupplementStatus).not.toHaveBeenCalled();
    expect(removeSupplementItems).not.toHaveBeenCalled();
  });

  it('a failed add is logged, keeps the input, and replaces nothing', async () => {
    (createSupplementItem as jest.Mock).mockRejectedValue(new Error('down'));
    const { onDismiss } = replace('pre-x');
    await userEvent.click(field('Name'));
    await userEvent.paste('Pre-Y');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('What you entered is still here');
    expect(logClientError).toHaveBeenCalledWith('supplements.addItem', expect.any(Error), undefined);
    expect(field('Name')).toHaveValue('Pre-Y');
    expect(setSupplementStatus).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('says so when the add worked but the replacement failed, and Try again does not add twice', async () => {
    (setSupplementStatus as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const { onDismiss } = replace('pre-x');
    await userEvent.click(field('Name'));
    await userEvent.paste('Pre-Y');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Added Pre-Y, but couldn’t move the items it replaces');
    expect(logClientError).toHaveBeenCalledWith('supplements.replaceItems', expect.any(Error), { items: 1, how: 'pending' });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('Added Pre-Y; moved 1 item to Pending.'));
    expect(createSupplementItem).toHaveBeenCalledTimes(1);
    expect(setSupplementStatus).toHaveBeenCalledTimes(2);
  });

  it('Remove them with two ticked removes both in one call, and says how many', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(400)]);
    const { onDismiss } = replace('pre-x');
    await typeName('Caffeine');
    await userEvent.click(row('EVL Trans4orm'));
    await userEvent.click(screen.getByRole('radio', { name: /Remove them/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('Added Caffeine; removed 2 items.'));
    expect((removeSupplementItems as jest.Mock).mock.calls).toEqual([[['pre-x', 'trans4orm'], '2026-11-21']]);
    expect(removeSupplementItem).not.toHaveBeenCalled();
  });

  it('after a remove fails, Try again sends every replaced item again, since none were removed', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(400)]);
    (removeSupplementItems as jest.Mock).mockRejectedValueOnce(new Error('down'));
    const { onDismiss } = replace('pre-x');
    await typeName('Caffeine');
    await userEvent.click(row('EVL Trans4orm'));
    await userEvent.click(screen.getByRole('radio', { name: /Remove them/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t remove the items it replaces. None of them changed');
    expect(logClientError).toHaveBeenCalledWith('supplements.replaceItems', expect.any(Error), { items: 2, how: 'remove' });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('Added Caffeine; removed 2 items.'));
    expect((removeSupplementItems as jest.Mock).mock.calls).toEqual([
      [['pre-x', 'trans4orm'], '2026-11-21'],
      [['pre-x', 'trans4orm'], '2026-11-21'],
    ]);
    expect(removeSupplementItem).not.toHaveBeenCalled();
    expect(createSupplementItem).toHaveBeenCalledTimes(1);
  });

  it('locks Close and Esc while the add and its replacement are in flight', async () => {
    let finish: (v: unknown) => void = () => {};
    (createSupplementItem as jest.Mock).mockReturnValue(new Promise((r) => (finish = r)));
    const { onDismiss, onCancel, dialog } = replace('pre-x');
    await userEvent.click(field('Name'));
    await userEvent.paste('Pre-Y');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    const esc = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => finish({}));
    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('keeps the replaced item’s slot when a catalog match suggests another', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([CREATINE]);
    replace('pre-x');
    await typeName('Creatine');
    expect(field(/^Slot/)).toHaveValue('pre');
  });

  it('marks the replaced item SAME SLOT only while the new one shares its slot', async () => {
    replace('trans4orm');
    expect(field(/^Slot/)).toHaveValue('am');
    expect(within(group()).getByText('SAME SLOT')).toBeInTheDocument();
    await userEvent.selectOptions(field(/^Slot/), 'pm');
    expect(within(group()).queryByText('SAME SLOT')).not.toBeInTheDocument();
    expect(row('EVL Trans4orm')).toBeChecked();
  });

  it('ticks nothing for an item added as pending, though it would replace a same-slot one', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(400)]);
    add('workout');
    await userEvent.selectOptions(field(/^Status/), 'pending');
    await typeName('Caffeine');
    expect(row('Nutricost Pre-X')).not.toBeChecked();
    expect(within(group()).getAllByText('SAME SLOT')).toHaveLength(1);
  });

  it('lists same-slot overlaps first whatever order the stack is in', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(400)]);
    const reordered = { ...STACK, items: [...STACK.items].reverse() };
    render(<SupplementForm stack={reordered} mode={{ kind: 'add', preset: 'workout' }} dayTypeId="lift" onCancel={jest.fn()} onDismiss={jest.fn()} />);
    await typeName('Caffeine');
    const boxes = within(group()).getAllByRole('checkbox');
    expect(boxes.map((b) => b.closest('label')?.querySelector('strong')?.textContent)).toEqual(['Nutricost Pre-X', 'EVL Trans4orm']);
  });

  it('never offers to replace an item that arrived on the stack after the form opened', async () => {
    (fetchSupplementCatalog as jest.Mock).mockResolvedValue([caffeine(400)]);
    const mode: FormMode = { kind: 'add', preset: 'workout' };
    const props = { mode, dayTypeId: 'lift', onCancel: jest.fn(), onDismiss: jest.fn() };
    const { rerender } = render(<SupplementForm stack={STACK} {...props} />);
    await typeName('Caffeine');
    const arrived = { ...(STACK.items[0] as SupplementItem), id: 'just-added', name: 'Caffeine (just added)' };
    rerender(<SupplementForm stack={{ ...STACK, items: [...STACK.items, arrived] }} {...props} />);
    expect(within(group()).queryByRole('checkbox', { name: /^Caffeine \(just added\)/ })).not.toBeInTheDocument();
    expect(row('Nutricost Pre-X')).toBeInTheDocument();
  });
});

describe('what closing the form announces', () => {
  it('an add says what was added', async () => {
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    const { onDismiss } = add('daily');
    await userEvent.click(field('Name'));
    await userEvent.paste('Glycine 2');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('Added Glycine 2.'));
  });

  it('an edit says it saved', async () => {
    (updateSupplementItem as jest.Mock).mockResolvedValue({});
    const { onDismiss } = editItem('glycine');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('Saved Glycine.'));
  });

  it('a remove says it removed', async () => {
    (removeSupplementItem as jest.Mock).mockResolvedValue({});
    const { onDismiss } = editItem('glycine');
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tap again to remove' }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('Removed Glycine.'));
  });

  it('× says nothing', async () => {
    const { onDismiss } = editItem('glycine');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledWith();
  });
});
