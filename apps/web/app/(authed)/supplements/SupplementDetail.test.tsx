import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupplementItem } from '@lifting-logbook/types';
import { supplementSourceUrl } from '@lifting-logbook/core';
import { STACK } from '@/lib/__tests__/supplementsTestStack';
import { buildView, type Stack } from '@/lib/supplementsView';
import SupplementDetail from './SupplementDetail';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({ updateSupplementItem: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/calendarDay', () => ({ localToday: () => '2026-11-21' }));

import { updateSupplementItem } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

function open(id: string, stack: Stack = STACK, onClose = jest.fn(), onEdit = jest.fn()) {
  const item = stack.items.find((i) => i.id === id) as SupplementItem;
  render(
    <SupplementDetail
      stack={stack}
      item={item}
      dayTypeId="lift"
      notes={buildView(stack, 'lift').notesByItem.get(id) ?? []}
      onClose={onClose}
      onEdit={onEdit}
    />,
  );
  return { dialog: screen.getByRole('dialog', { name: item.name }), onClose, onEdit };
}

const withItem = (id: string, over: Partial<SupplementItem>): Stack => ({
  ...STACK,
  items: STACK.items.map((i) => (i.id === id ? { ...i, ...over } : i)),
});

beforeEach(() => jest.clearAllMocks());

describe('SupplementDetail for Pre-X on a lift day', () => {
  it('shows every section, in order', () => {
    const { dialog } = open('pre-x');
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Worth a look',
      'How you take it',
      'Where to buy',
      'Supplement facts',
      'Overlaps · Lift day',
      'Why athletes take it',
      'Evidence',
      'Good to know',
      'Sources',
    ]);
  });

  it('opens each worth-a-look callout with its bold sentence, with no error styling', () => {
    const { dialog } = open('pre-x');
    const callouts = dialog.querySelectorAll('p[class*="callout"]');
    expect(callouts).toHaveLength(2);
    expect(callouts[0].querySelector('strong')).toHaveTextContent('Stimulant at 4:30 PM, after your 3:00 PM caffeine cutoff.');
    expect(callouts[1].querySelector('strong')).toHaveTextContent('~388 mg caffeine from supplements on lift days.');
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
  });

  it('lists how you take it: key compound, every dose, timing', () => {
    const { dialog } = open('pre-x');
    expect(dialog).toHaveTextContent('Key compound300 mg caffeine · 4 g citrulline');
    expect(dialog).toHaveTextContent('1 scoop · Pre-workout (Lift day)');
    expect(dialog).toHaveTextContent('Timing30–60 min before');
  });

  it('shows overlaps as ingredient, this item and day total, with a caption', () => {
    const { dialog } = open('pre-x');
    const section = within(dialog).getByRole('heading', { name: /Overlaps/ }).closest('section') as HTMLElement;
    expect(section).toHaveTextContent('Day total = everything you take on a lift day.');
    const caffeine = within(section).getByRole('row', { name: /^Caffeine/ });
    expect(within(caffeine).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'CaffeineAlso from EVL Trans4orm (87.5 mg)',
      '300 mg',
      '387.5 mg',
    ]);
    expect(within(section).getByRole('row', { name: /^Vitamin b6/ })).toHaveTextContent('60 mg61 mg');
    // Huperzine A has no second source.
    expect(within(section).queryByRole('row', { name: /^Huperzine/ })).toBeNull();
  });

  it('shows the evidence level and resolves sources from their keys', () => {
    const { dialog } = open('pre-x');
    expect(dialog).toHaveTextContent('Strong evidence Caffeine reliably improves performance.');
    const url = supplementSourceUrl('issn-caffeine') as string;
    expect(within(dialog).getByRole('link', { name: url.replace('https://', '') })).toHaveAttribute('href', url);
  });

  it('closes when the native dialog closes (Esc), and from the × button', async () => {
    const { dialog, onClose } = open('pre-x');
    fireEvent(dialog, new Event('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('SupplementDetail facts', () => {
  it('tints the ingredients the item’s advisories read, ashwagandha at night included', () => {
    const { dialog } = open('ashwagandha');
    expect(within(dialog).getByRole('cell', { name: 'Ashwagandha' }).closest('tr')).toHaveClass('flaggedCell');
  });

  it('tints caffeine on Pre-X but not an ingredient no advisory reads', () => {
    const { dialog } = open('pre-x');
    expect(within(dialog).getByRole('cell', { name: 'Caffeine' }).closest('tr')).toHaveClass('flaggedCell');
    expect(within(dialog).getByRole('cell', { name: 'L citrulline' }).closest('tr')).not.toHaveClass('flaggedCell');
  });
});

describe('SupplementDetail with no day types', () => {
  it('still shows overlaps for every-day doses, with a per-day caption', () => {
    const stack: Stack = { ...STACK, dayTypes: [] };
    const item = stack.items.find((i) => i.id === 'trans4orm') as SupplementItem;
    const withB6 = { ...stack, items: [...stack.items, { ...item, id: 'b6', name: 'B6 tab', ingredients: [{ key: 'vitamin-b6', amount: 2, unit: 'mg' as const }] }] };
    render(<SupplementDetail stack={withB6} item={item} dayTypeId="" notes={[]} onClose={jest.fn()} onEdit={jest.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'EVL Trans4orm' });
    expect(within(dialog).getByRole('heading', { name: 'Overlaps · Every day' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Day total = everything you take in a day.');
  });
});

describe('SupplementDetail without reference content', () => {
  it('skips why, evidence, good to know and sources, and says when there is no label', () => {
    const { dialog } = open('glycine');
    const headings = within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).not.toEqual(expect.arrayContaining(['Why athletes take it', 'Evidence', 'Good to know', 'Sources']));
    expect(dialog).toHaveTextContent('No label entered yet.');
    expect(dialog).toHaveTextContent('no amount yet · Morning');
    expect(dialog).toHaveTextContent('A dose has no amount.');
  });
});

describe('SupplementDetail where to buy', () => {
  it('shows the lifter’s links with the store and host, and no suggestion', () => {
    const { dialog } = open('fish-oil');
    expect(within(dialog).getByRole('link', { name: 'Amazon ↗' })).toHaveAttribute('href', 'https://www.amazon.com/dp/B000');
    expect(dialog).toHaveTextContent('amazon.com');
    expect(within(dialog).queryByText('suggested')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Keep' })).toBeNull();
  });

  it('shows a link’s label when it has one, and the store name when it doesn’t', () => {
    const stack = withItem('fish-oil', { links: [{ label: 'Costco bulk', url: 'https://www.costco.com/x' }, { label: '', url: 'https://www.iherb.com/y' }] });
    const { dialog } = open('fish-oil', stack);
    expect(within(dialog).getByRole('link', { name: 'Costco bulk ↗' })).toHaveAttribute('href', 'https://www.costco.com/x');
    expect(within(dialog).getByRole('link', { name: 'iHerb ↗' })).toBeInTheDocument();
  });

  it('shows the item’s category as the sub-line when set, and its slots otherwise', () => {
    const subLine = (d: HTMLElement) => within(d).getByRole('heading', { level: 2 }).parentElement?.textContent;
    expect(subLine(open('glycine').dialog)).toBe('GlycineMorning');
    document.body.innerHTML = '';
    expect(subLine(open('glycine', withItem('glycine', { category: 'Sleep' })).dialog)).toBe('GlycineSleep');
  });

  it('Edit asks the page to open the form', async () => {
    const { dialog, onEdit } = open('glycine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalled();
  });

  it('never makes a link of a non-http address', () => {
    const { dialog } = open('fish-oil', withItem('fish-oil', { links: [{ label: '', url: 'javascript:alert(1)' }] }));
    expect(within(dialog).queryByRole('link')).toBeNull();
  });

  it('with none, suggests a search at the store linked to most (Amazon by default), and Keep saves it', async () => {
    const { dialog } = open('glycine');
    const search = within(dialog).getByRole('link', { name: 'Search Amazon ↗' });
    expect(search).toHaveAttribute('href', 'https://www.amazon.com/s?k=Glycine');
    expect(within(dialog).getByText('suggested')).toBeInTheDocument();
    (updateSupplementItem as jest.Mock).mockResolvedValue({});
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    expect(updateSupplementItem).toHaveBeenCalledWith('glycine', { links: [{ label: '', url: 'https://www.amazon.com/s?k=Glycine' }] }, '2026-11-21');
    expect(refresh).toHaveBeenCalled();
  });

  it('suggests the store the lifter links to most', () => {
    const stack = withItem('fish-oil', { links: [{ label: '', url: 'https://www.iherb.com/pr/a' }, { label: '', url: 'https://iherb.com/pr/b' }] });
    const { dialog } = open('glycine', stack);
    expect(within(dialog).getByRole('link', { name: 'Search iHerb ↗' })).toHaveAttribute('href', 'https://www.iherb.com/search?kw=Glycine');
  });

  it('shows no suggestion for a mix', () => {
    const stack = withItem('glycine', { parts: [{ itemId: 'x', name: 'Part', ingredients: [] }] });
    const { dialog } = open('glycine', stack);
    expect(within(dialog).queryByText('suggested')).toBeNull();
    expect(dialog).toHaveTextContent('No link saved.');
  });

  it('reports a failed Keep through logClientError and says so, without losing the suggestion', async () => {
    const failure = new Error('API 500');
    (updateSupplementItem as jest.Mock).mockRejectedValue(failure);
    const { dialog } = open('glycine');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
    expect(logClientError).toHaveBeenCalledWith('supplements.keepLink', failure, { itemId: 'glycine' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Couldn’t save the link');
    expect(refresh).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Keep' })).toBeEnabled();
  });
});
