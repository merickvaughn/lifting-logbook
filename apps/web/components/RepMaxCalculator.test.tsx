import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { estimateRepMax } from '@lifting-logbook/core';
import { APP_NAV_TOOLS_ID } from '@/lib/app-nav-tools';
import RepMaxCalculator from './RepMaxCalculator';

let mockPathname = '/macrocycle/1/workout/1';
jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

/** The calculator with the app header's slot for its button. */
function InNav({ unit = 'lbs' }: { unit?: 'lbs' | 'kg' }) {
  return (
    <>
      <div id={APP_NAV_TOOLS_ID} data-testid="nav-tools" />
      <RepMaxCalculator unit={unit} />
    </>
  );
}

async function openWith(weight: string, reps: string, unit: 'lbs' | 'kg' = 'lbs') {
  const user = userEvent.setup();
  render(<InNav unit={unit} />);
  await user.click(screen.getByRole('button', { name: 'Rep max calculator' }));
  if (weight) await user.type(screen.getByLabelText(`Weight (${unit})`), weight);
  if (reps) await user.type(screen.getByLabelText('Reps'), reps);
  return user;
}

function rowFor(count: number) {
  return screen.getByRole('row', { name: new RegExp(`^${count} `) });
}

describe('RepMaxCalculator', () => {
  it('is closed until asked for', () => {
    render(<InNav />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts its button in the app header, labelled for what it opens', () => {
    render(<InNav />);
    const button = within(screen.getByTestId('nav-tools')).getByRole('button', {
      name: 'Rep max calculator',
    });
    expect(button).toHaveTextContent('Rep max');
  });

  it('estimates a one-rep max from a set', async () => {
    await openWith('200', '5');
    expect(screen.getByText('Estimated one-rep max').parentElement).toHaveTextContent('225 lbs');
  });

  it('estimates the weight for 1 to 10 reps', async () => {
    await openWith('200', '5');
    for (let count = 1; count <= 10; count++) {
      expect(rowFor(count)).toHaveTextContent(`${estimateRepMax(200, 5, count)} lbs`);
    }
    expect(rowFor(10)).toHaveTextContent('167.5 lbs');
    expect(screen.queryByRole('row', { name: /^11 / })).toBeNull();
  });

  it('shows the entered set unchanged at its own rep count', async () => {
    await openWith('210', '3');
    expect(rowFor(3)).toHaveTextContent('210 lbs');
  });

  it.each([
    ['reps past the formula', '200', '37', 'The estimate only works up to 36 reps.'],
    ['zero reps', '200', '0', 'Enter at least 1 rep.'],
    ['negative reps', '200', '-3', 'Enter at least 1 rep.'],
    ['part of a rep', '200', '2.5', 'Enter a whole number of reps.'],
    ['zero weight', '0', '5', 'Enter a weight above 0.'],
    ['negative weight', '-10', '5', 'Enter a weight above 0.'],
    ['a weight that floors to nothing', '2', '1', 'Too light to estimate: estimates round down to the nearest 2.5 lbs.'],
    ['a weight past any real set', '10000', '5', 'Enter a weight up to 9999 lbs.'],
    ['a stray exponent', '1e21', '5', 'Enter a weight up to 9999 lbs.'],
    ['a weight whose estimate would overflow', '1e307', '5', 'Enter a weight up to 9999 lbs.'],
  ])('explains %s rather than showing 0', async (_name, weight, reps, message) => {
    await openWith(weight, reps);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText('Estimated one-rep max')).toBeNull();
    expect(screen.queryByText(/^0( |$)/)).toBeNull();
  });

  it.each(['Weight (lbs)', 'Reps'])('explains text %s can not read', async (label) => {
    await openWith('', '');
    const input = screen.getByLabelText(label);

    // jsdom's number inputs never report badInput, so the browser's half is in the e2e spec.
    const report = (badInput: boolean) => {
      Object.defineProperty(input, 'validity', { configurable: true, value: { badInput } });
      fireEvent.input(input);
    };

    report(true);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a number.');
    expect(screen.queryByText('Enter a weight and reps from one set.')).toBeNull();

    report(false);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('Enter a weight and reps from one set.')).toBeInTheDocument();
  });

  it('announces through a status region that was already there', async () => {
    await openWith('', '');
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();

    await userEvent.setup().type(screen.getByLabelText('Weight (lbs)'), '-1');
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Enter a weight above 0.');

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Weight (lbs)'));
    await user.type(screen.getByLabelText('Weight (lbs)'), '200');
    await user.type(screen.getByLabelText('Reps'), '5');
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Estimated one-rep max225 lbs');
  });

  it.each([
    ['1.25', '1.25 lbs', '218.75 lbs'],
    ['2.5', '2.5 lbs', '217.5 lbs'],
    ['5', '5 lbs', '215 lbs'],
    ['10', '10 lbs', '210 lbs'],
  ])('rounds down to %s when asked', async (value, option, twoReps) => {
    const user = await openWith('225', '1');
    const rounding = screen.getByLabelText('Round down to');
    await user.selectOptions(rounding, value);
    expect(rounding).toHaveDisplayValue(option);
    expect(rowFor(2)).toHaveTextContent(twoReps);
  });

  it('rounds the one-rep max down as well', async () => {
    const user = await openWith('210', '3');
    expect(screen.getByText('Estimated one-rep max').parentElement).toHaveTextContent('220 lbs');
    await user.selectOptions(screen.getByLabelText('Round down to'), '1.25');
    expect(screen.getByText('Estimated one-rep max').parentElement).toHaveTextContent('221.25 lbs');
  });

  it('says what a set is too light for at the chosen rounding', async () => {
    const user = await openWith('8', '1');
    expect(screen.getByText('Estimated one-rep max').parentElement).toHaveTextContent('7.5 lbs');
    await user.selectOptions(screen.getByLabelText('Round down to'), '10');
    expect(
      screen.getByText('Too light to estimate: estimates round down to the nearest 10 lbs.'),
    ).toBeInTheDocument();
  });

  it('rounds down to 2.5 until told otherwise', async () => {
    await openWith('', '');
    expect(screen.getByLabelText('Round down to')).toHaveDisplayValue('2.5 lbs');
  });

  it('points the invalid field at its message', async () => {
    await openWith('200', '37');
    const reps = screen.getByLabelText('Reps');
    expect(reps).toHaveAttribute('aria-invalid', 'true');
    expect(reps).toHaveAccessibleDescription('The estimate only works up to 36 reps.');
    expect(screen.getByLabelText('Weight (lbs)')).not.toHaveAttribute('aria-invalid');
  });

  it('asks for a set before it has one, without an error', async () => {
    await openWith('200', '');
    expect(screen.getByText('Enter a weight and reps from one set.')).toBeInTheDocument();
    expect(screen.queryByText('Estimated one-rep max')).toBeNull();
    expect(screen.getByLabelText('Weight (lbs)')).not.toHaveAttribute('aria-invalid');
  });

  it('marks a rep count too light to estimate rather than showing 0', async () => {
    await openWith('2.5', '1');
    expect(screen.getByText('Estimated one-rep max').parentElement).toHaveTextContent('2.5 lbs');
    expect(rowFor(10)).toHaveTextContent('—');
  });

  it.each([
    ['lbs', 'Weight (lbs)', '200', '225 lbs', '167.5 lbs', '2.5 lbs'],
    ['kg', 'Weight (kg)', '100', '112.5 kg', '82.5 kg', '2.5 kg'],
  ] as const)('follows the %s preference', async (unit, label, weight, oneRm, tenReps, increment) => {
    await openWith(weight, '5', unit);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByText('Estimated one-rep max').parentElement).toHaveTextContent(oneRm);
    expect(rowFor(10)).toHaveTextContent(tenReps);
    expect(screen.getByLabelText('Round down to')).toHaveDisplayValue(increment);
  });

  it('makes no API call while being used', async () => {
    const fetchSpy = jest.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy;
    try {
      const user = await openWith('200', '5');
      await user.clear(screen.getByLabelText('Reps'));
      await user.type(screen.getByLabelText('Reps'), '8');
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('moves focus in, keeps it in, and hands it back on Escape', async () => {
    const user = await openWith('', '');
    const trigger = screen.getByRole('button', { name: 'Rep max calculator' });
    const weight = screen.getByLabelText('Weight (lbs)');
    const reps = screen.getByLabelText('Reps');
    const rounding = screen.getByLabelText('Round down to');
    const close = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });

    expect(weight).toHaveFocus();
    await user.tab();
    expect(reps).toHaveFocus();
    await user.tab();
    expect(rounding).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(weight).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('takes focus back when the page moves it', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Start timed workout</button>
        <InNav />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Rep max calculator' }));
    const outside = screen.getByText('Start timed workout');

    act(() => outside.focus());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Weight (lbs)')).toHaveFocus();
  });

  it('closes when the page changes, and keeps the entries', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InNav />);
    const trigger = screen.getByRole('button', { name: 'Rep max calculator' });
    await user.click(trigger);
    await user.type(screen.getByLabelText('Weight (lbs)'), '200');

    const start = mockPathname;
    mockPathname = `${start}/detail`;
    try {
      rerender(<InNav />);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(trigger).toHaveFocus();

      await user.click(trigger);
      expect(screen.getByLabelText('Weight (lbs)')).toHaveValue(200);
    } finally {
      mockPathname = start;
    }
  });

  it('closes from the backdrop but not from a click inside', async () => {
    const user = await openWith('', '');
    const dialog = screen.getByRole('dialog');
    await user.click(screen.getByText(/Nothing here is saved/));
    expect(dialog).toBeInTheDocument();
    await user.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open when a drag from an input ends on the backdrop', async () => {
    const user = await openWith('200', '');
    const dialog = screen.getByRole('dialog');
    await user.pointer([
      { keys: '[MouseLeft>]', target: screen.getByLabelText('Weight (lbs)') },
      { target: dialog.parentElement as HTMLElement },
      { keys: '[/MouseLeft]' },
    ]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('forgets unreadable text when closed, since the field reopens empty', async () => {
    const user = await openWith('', '');
    const weight = screen.getByLabelText('Weight (lbs)');
    Object.defineProperty(weight, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.input(weight);
    expect(screen.getByText('Enter a number.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Rep max calculator' }));
    expect(screen.queryByText('Enter a number.')).toBeNull();
    expect(screen.getByLabelText('Weight (lbs)')).not.toHaveAttribute('aria-invalid');
  });

  it('keeps the entries when reopened', async () => {
    const user = await openWith('200', '5');
    await user.selectOptions(screen.getByLabelText('Round down to'), '5');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Rep max calculator' }));
    expect(screen.getByLabelText('Weight (lbs)')).toHaveValue(200);
    expect(screen.getByLabelText('Reps')).toHaveValue(5);
    expect(screen.getByLabelText('Round down to')).toHaveDisplayValue('5 lbs');
  });
});
