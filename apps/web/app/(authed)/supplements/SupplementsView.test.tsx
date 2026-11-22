import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STACK } from '@/lib/__tests__/supplementsTestStack';
import SupplementsView from './SupplementsView';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/client-api', () => ({
  updateSupplementItem: jest.fn(),
  createSupplementItem: jest.fn(),
  removeSupplementItem: jest.fn(),
  setSupplementStatus: jest.fn(),
  updateSupplementSettings: jest.fn(),
  fetchSupplementCatalog: jest.fn().mockResolvedValue([]),
  fetchSupplementChanges: jest.fn().mockResolvedValue([]),
  fetchSupplementsAsOf: jest.fn().mockResolvedValue({ items: [], dayTypes: [], firstChangeDate: null, anomalies: [] }),
  fetchSupplementSheet: jest.fn(),
  importSupplements: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

import {
  createSupplementItem,
  fetchSupplementSheet,
  importSupplements,
  setSupplementStatus,
  updateSupplementSettings,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

const row = (name: RegExp) => screen.getByRole('button', { name });

const replaceState = jest.spyOn(window.history, 'replaceState');
beforeEach(() => replaceState.mockClear());

describe('SupplementsView opened from a Lift History link', () => {
  it('opens History at the date, and drops the date from the address when it closes', async () => {
    render(<SupplementsView stack={STACK} historyDate="2026-06-01" />);
    const dialog = screen.getByRole('dialog', { name: 'Supplement history' });
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-06-01');
    await within(dialog).findByText('No changes yet.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(replaceState).toHaveBeenCalledWith(null, '', '/supplements');
    expect(screen.getByRole('button', { name: 'History' })).toHaveFocus();
  });
});

describe('SupplementsView on a lift day', () => {
  beforeEach(() => render(<SupplementsView stack={STACK} />));

  it('opens History as a dialog, and takes focus back to History when it closes', async () => {
    const history = screen.getByRole('button', { name: 'History' });
    await userEvent.click(history);
    const dialog = screen.getByRole('dialog', { name: 'Supplement history' });
    await within(dialog).findByText('No changes yet.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(history).toHaveFocus();
    // Opened from the page, so there's no date in the address to drop.
    expect(replaceState).not.toHaveBeenCalled();
  });

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

  it('× on the form closes the panel too, and focus goes back to the row', async () => {
    await userEvent.click(row(/Nutricost Pre-X/));
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Edit Nutricost Pre-X' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(row(/Nutricost Pre-X/)).toHaveFocus();
  });

  it('× on an Add form sends focus back to the button that opened it', async () => {
    const opener = screen.getByRole('button', { name: '+ Add daily item' });
    await userEvent.click(opener);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Add supplement' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
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

describe('Replace with… and Edit days', () => {
  it('Replace with… in the detail panel opens the Add form listing that item', async () => {
    render(<SupplementsView stack={STACK} />);
    await userEvent.click(row(/Nutricost Pre-X/));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Nutricost Pre-X' })).getByRole('button', { name: 'Replace with…' }));
    const form = screen.getByRole('dialog', { name: 'Add supplement' });
    expect(within(form).getByRole('group', { name: 'Replace what you already take?' })).toHaveTextContent('Nutricost Pre-XSAME SLOTYou chose to replace this');
  });

  it('Edit days opens the Day types dialog and Cancel returns focus to the button', async () => {
    render(<SupplementsView stack={STACK} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit days' }));
    expect(screen.getByRole('dialog', { name: 'Day types' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Day types' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit days' })).toHaveFocus();
  });

  it('a Replace with… add says what it did and focuses Edit stack, since the replaced row moves', async () => {
    (createSupplementItem as jest.Mock).mockResolvedValue({});
    (setSupplementStatus as jest.Mock).mockResolvedValue({});
    render(<SupplementsView stack={STACK} />);
    await userEvent.click(row(/Nutricost Pre-X/));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Nutricost Pre-X' })).getByRole('button', { name: 'Replace with…' }));
    await userEvent.click(screen.getByLabelText('Name'));
    await userEvent.paste('Pre-Y');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByTestId('supp-announcement')).toHaveTextContent('Added Pre-Y; moved 1 item to Pending.'));
    expect(screen.queryByRole('dialog', { name: 'Add supplement' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit stack' })).toHaveFocus();
  });

  it('saving Edit days announces it, falls back from a removed day type, and reopens with what was saved', async () => {
    (updateSupplementSettings as jest.Mock).mockResolvedValue({});
    render(<SupplementsView stack={STACK} />);
    expect(screen.getByRole('button', { name: 'Lift day' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Edit days' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Lift day' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Day types' })).not.toBeInTheDocument());
    expect(screen.getByTestId('supp-announcement')).toHaveTextContent('Saved day types.');
    expect(screen.getByRole('button', { name: 'Edit days' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Rest day' })).toHaveAttribute('aria-pressed', 'true');
    // The refresh hasn't brought the new stack yet: reopening starts from what was saved, so a
    // second Save can't write Lift day back.
    await userEvent.click(screen.getByRole('button', { name: 'Edit days' }));
    const days = screen.getByRole('dialog', { name: 'Day types' });
    expect(within(days).getByLabelText('Name of day type 1')).toHaveValue('Rest day');
    expect(within(days).queryByLabelText('Name of day type 2')).not.toBeInTheDocument();
  });
});

describe('Import from Google Sheets', () => {
  const sheetRows = [
    ['Compound', 'Amount', 'Timing'],
    ['Potassium', '1000mg', 'TID'],
    ['Iron', '18mg', 'bedtime'],
  ];
  const SHEET = { tabs: [{ name: 'Supplements', rows: sheetRows, links: sheetRows.map((r) => r.map(() => '')), skipReason: null }] };

  async function openImport() {
    render(<SupplementsView stack={STACK} />);
    const button = screen.getByRole('button', { name: 'Import from Google Sheets' });
    await userEvent.click(button);
    return { button, dialog: screen.getByRole('dialog', { name: 'Import from Google Sheets' }) };
  }

  it('the page’s button opens the dialog, and closing it returns focus to the button', async () => {
    const { button, dialog } = await openImport();
    expect(within(dialog).getByRole('heading', { name: 'Paste a link' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Import from Google Sheets' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(importSupplements).not.toHaveBeenCalled();
  });

  it('an import announces how many items it added, and returns focus to the button', async () => {
    (fetchSupplementSheet as jest.Mock).mockResolvedValue(SHEET);
    (importSupplements as jest.Mock).mockResolvedValue({});
    const { button, dialog } = await openImport();
    await userEvent.click(within(dialog).getByLabelText('Google Sheets link'));
    await userEvent.paste('https://docs.google.com/spreadsheets/d/abc/edit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Read sheet' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Supplements' }));
    // Potassium is in the stack already, so it starts as skipped and only Iron is imported.
    expect(within(dialog).getByLabelText('Potassium (row 2)')).toHaveValue('skip');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import 1 item' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import from Google Sheets' })).not.toBeInTheDocument());
    expect(screen.getByTestId('supp-announcement')).toHaveTextContent('Imported 1 item.');
    expect(button).toHaveFocus();
  });
});
