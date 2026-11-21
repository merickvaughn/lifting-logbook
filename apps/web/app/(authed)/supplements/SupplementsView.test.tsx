import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STACK } from '@/lib/__tests__/supplementsTestStack';
import SupplementsView from './SupplementsView';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/client-api', () => ({
  updateSupplementItem: jest.fn(),
  createSupplementItem: jest.fn(),
  removeSupplementItem: jest.fn(),
  fetchSupplementCatalog: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

import { logClientError } from '@/lib/log-client-error';

const row = (name: RegExp) => screen.getByRole('button', { name });

describe('SupplementsView on a lift day', () => {
  beforeEach(() => render(<SupplementsView stack={STACK} />));

  it('shows the subtitle counts, the switcher and the protein card with the other day type', () => {
    // Flagged: Pre-X, Trans4orm, Potassium, Creatine, Glycine, Ashwagandha.
    expect(screen.getByText('10 active · 6 items have a note worth a look · tap any item for details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lift day' })).toHaveAttribute('aria-pressed', 'true');
    const card = screen.getByRole('region', { name: 'Supplemental protein' });
    expect(card).toHaveTextContent('24 g lift day');
    expect(card).toHaveTextContent(
      'From Quest protein (vanilla milkshake) (24 g) · Rest day: 0 g · free amino acids (citrulline, taurine, glycine) aren’t counted',
    );
  });

  it('splits Workout into pre, intra and post, saying so when a slot is empty, with an Item / Your dose header', () => {
    const workout = screen.getByRole('region', { name: 'Workout · Lift day' });
    expect(within(workout).getByText('Session at 4:30 PM')).toBeInTheDocument();
    expect(within(workout).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Pre-workout',
      'Intra-workout',
      'Post-workout',
    ]);
    expect(within(workout).getByText('Nothing intra-workout')).toBeInTheDocument();
    expect(within(workout).getByText('Nothing post-workout')).toBeInTheDocument();
    expect(within(workout).getByText('Item')).toBeInTheDocument();
    expect(within(workout).getByText('Your dose')).toBeInTheDocument();
  });

  it('splits Every day by time of day and hides empty slots', () => {
    const daily = screen.getByRole('region', { name: 'Every day' });
    expect(within(daily).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Throughout the day',
      'Morning',
      'Night',
    ]);
    expect(within(daily).getByText('Your dose')).toBeInTheDocument();
  });

  it('shows dose, range, protein, key compound · timing and the lifter’s note on a row', () => {
    expect(row(/Magnesium glycinate/)).toHaveTextContent('200 mg (100–400 mg)');
    expect(row(/Quest protein/)).toHaveTextContent('24 g protein');
    expect(row(/Quest protein/)).toHaveTextContent('With banana slices');
    expect(row(/Nutricost Pre-X/)).toHaveTextContent('300 mg caffeine · 4 g citrulline · 30–60 min before');
    // The key compound repeats the name, so line 2 is the timing alone.
    expect(row(/^Glycine/)).toHaveTextContent(/^Glycine(dose\?)With food•/);
    expect(row(/^Glycine/)).not.toHaveTextContent('Glycine · ');
  });

  it('shows an item dosed in two slots in both, tagged "also …"', () => {
    const creatine = screen.getAllByRole('button', { name: /Creatine monohydrate/ });
    expect(creatine).toHaveLength(2);
    expect(creatine[0]).toHaveTextContent('also throughout the day');
    expect(creatine[0]).toHaveTextContent('dose?');
    expect(creatine[1]).toHaveTextContent('also pre-workout');
    expect(creatine[1]).toHaveTextContent('5 g');
  });

  it('tints and adds one line per advisory: late stimulant and caffeine total on Pre-X', () => {
    const preX = row(/Nutricost Pre-X/);
    expect(preX).toHaveTextContent('• Stimulant at 4:30 PM, after your 3:00 PM caffeine cutoff');
    expect(preX).toHaveTextContent('• ~388 mg caffeine from supplements on lift days');
    // Trans4orm adds caffeine but isn't taken around the session.
    expect(row(/EVL Trans4orm/)).toHaveTextContent('~388 mg caffeine');
    expect(row(/EVL Trans4orm/)).not.toHaveTextContent('Stimulant at');
    expect(row(/^Potassium/)).toHaveTextContent('Above the 3,400 mg daily target by itself');
    expect(row(/Ashwagandha/)).toHaveTextContent('Can feel activating at night for some people');
    // A blank dose is flagged on its own row only.
    expect(screen.getAllByRole('button', { name: /Creatine monohydrate/ })[0]).toHaveTextContent('A dose has no amount');
    expect(screen.getAllByRole('button', { name: /Creatine monohydrate/ })[1]).not.toHaveTextContent('A dose has no amount');
  });

  it('collapses Pending by default and shows where each item would go when opened', async () => {
    const toggle = screen.getByRole('button', { name: /Pending · 1/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Hydrolyzed collagen/ })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(row(/Hydrolyzed collagen/)).toHaveTextContent('Pre-workout (Lift day) · Glycine · proline · In the shake');
    expect(row(/Hydrolyzed collagen/)).toHaveTextContent('9 g protein');
  });

  it('says "lift", never "exercise"', () => {
    expect(document.body.textContent).not.toMatch(/exercise/i);
  });

  it('opens the detail panel from a row, and focus goes back to the row when it closes', async () => {
    await userEvent.click(row(/Nutricost Pre-X/));
    const dialog = screen.getByRole('dialog', { name: 'Nutricost Pre-X' });
    expect(dialog).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(row(/Nutricost Pre-X/)).toHaveFocus();
  });
});

describe('SupplementsView add and edit entry points', () => {
  beforeEach(() => render(<SupplementsView stack={STACK} />));

  it.each([
    ['+ Add to this day', 'pre', 'active'],
    ['+ Add daily item', 'am', 'active'],
    ['+ Add a pending item', 'am', 'pending'],
  ])('%s opens Add supplement with its preset', async (button, slot, status) => {
    await userEvent.click(screen.getByRole('button', { name: button }));
    const dialog = screen.getByRole('dialog', { name: 'Add supplement' });
    expect(within(dialog).getByLabelText(/^Slot/)).toHaveValue(slot);
    expect(within(dialog).getByLabelText('Status')).toHaveValue(status);
  });

  it('the detail panel’s Edit opens Edit <name> above it, and Cancel returns to the panel', async () => {
    await userEvent.click(row(/Nutricost Pre-X/));
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit Nutricost Pre-X' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Edit Nutricost Pre-X' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Nutricost Pre-X' })).toBeInTheDocument();
  });

  it('× on the form closes the panel too', async () => {
    await userEvent.click(row(/Nutricost Pre-X/));
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Edit Nutricost Pre-X' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SupplementsView for a new stack', () => {
  it('with no day types, shows every-day doses, the items no day places, and Pending', async () => {
    render(<SupplementsView stack={{ ...STACK, dayTypes: [] }} />);
    expect(screen.queryByRole('group', { name: 'Day type' })).not.toBeInTheDocument();
    const workout = screen.getByRole('region', { name: 'Workout' });
    expect(workout).toHaveTextContent('No day types set up yet, so workout doses aren’t shown.');
    expect(within(screen.getByRole('region', { name: 'Every day' })).getByRole('button', { name: /Creatine monohydrate/ })).toBeInTheDocument();
    const unscheduled = screen.getByRole('region', { name: 'Not scheduled' });
    expect(within(unscheduled).getByRole('button', { name: /Nutricost Pre-X/ })).toHaveTextContent('Not set for any day type');
    await userEvent.click(screen.getByRole('button', { name: /Pending · 1/ }));
    expect(row(/Hydrolyzed collagen peptides/)).toBeInTheDocument();
  });

  it('shows an active item with no doses under Not scheduled', () => {
    const fresh = { id: 'new', name: 'New powder', keyCompound: '', timing: '', shortNote: '', longNote: '', status: 'active' as const, unverified: false, links: [], category: '', typicalRange: '', ingredients: [], doses: [] };
    render(<SupplementsView stack={{ ...STACK, items: [fresh] }} />);
    const unscheduled = screen.getByRole('region', { name: 'Not scheduled' });
    expect(within(unscheduled).getByRole('button', { name: /New powder/ })).toHaveTextContent('dose?No dose yet');
  });

  it('marks an unverified item as not counted', () => {
    const items = STACK.items.map((i) => (i.id === 'fish-oil' ? { ...i, unverified: true } : i));
    render(<SupplementsView stack={{ ...STACK, items }} />);
    expect(row(/Fish oil/)).toHaveTextContent('unverified, not counted');
    expect(row(/Magnesium glycinate/)).not.toHaveTextContent('not counted');
  });

  it('shows the stack without notes, and reports it, when a stored time is malformed', () => {
    render(<SupplementsView stack={{ ...STACK, caffeineCutoff: '3pm' }} />);
    expect(screen.getByText('Notes worth a look couldn’t be worked out for this day, so none are shown.')).toBeInTheDocument();
    expect(row(/Nutricost Pre-X/)).not.toHaveTextContent('•');
    expect(logClientError).toHaveBeenCalledWith('supplements.advisories', expect.any(RangeError), { dayTypeId: 'lift' });
  });
});

describe('SupplementsView on a rest day', () => {
  beforeEach(async () => {
    render(<SupplementsView stack={STACK} />);
    await userEvent.click(screen.getByRole('button', { name: 'Rest day' }));
  });

  it('shows no workout card body and a zero protein total with the lift day’s', () => {
    const card = screen.getByRole('region', { name: 'Supplemental protein' });
    expect(card).toHaveTextContent('0 g rest day');
    expect(card).toHaveTextContent('None on this day · Lift day: 24 g · free amino acids');
    const workout = screen.getByRole('region', { name: 'Workout · Rest day' });
    expect(within(workout).getByText('No session time set')).toBeInTheDocument();
    expect(within(workout).getByText('Nothing workout-specific on rest days.')).toBeInTheDocument();
    expect(within(workout).queryByText('Your dose')).not.toBeInTheDocument();
    expect(within(workout).getByText('0 items')).toBeInTheDocument();
  });

  it('keeps only the every-day rows and drops the lift-day advisories', () => {
    expect(screen.queryByRole('button', { name: /Nutricost Pre-X/ })).not.toBeInTheDocument();
    expect(row(/EVL Trans4orm/)).not.toHaveTextContent('caffeine from supplements');
    expect(row(/Ashwagandha/)).toHaveTextContent('Can feel activating at night');
  });
});
