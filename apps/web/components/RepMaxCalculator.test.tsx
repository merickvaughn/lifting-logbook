import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { estimateRepMax } from '@lifting-logbook/core';
import RepMaxCalculator from './RepMaxCalculator';

async function openWith(weight: string, reps: string, unit: 'lbs' | 'kg' = 'lbs') {
  const user = userEvent.setup();
  render(<RepMaxCalculator unit={unit} />);
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
    render(<RepMaxCalculator unit="lbs" />);
    expect(screen.queryByRole('dialog')).toBeNull();
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
  ])('explains %s rather than showing 0', async (_name, weight, reps, message) => {
    await openWith(weight, reps);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText('Estimated one-rep max')).toBeNull();
    expect(screen.queryByText(/^0( |$)/)).toBeNull();
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
    expect(screen.getByText(/rounded down to the nearest/)).toHaveTextContent(increment);
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
    const close = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });

    expect(weight).toHaveFocus();
    await user.tab();
    expect(reps).toHaveFocus();
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

  it('closes from the backdrop but not from a click inside', async () => {
    const user = await openWith('', '');
    const dialog = screen.getByRole('dialog');
    await user.click(screen.getByText(/Nothing here is saved/));
    expect(dialog).toBeInTheDocument();
    await user.click(dialog.parentElement as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the entries when reopened', async () => {
    const user = await openWith('200', '5');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Rep max calculator' }));
    expect(screen.getByLabelText('Weight (lbs)')).toHaveValue(200);
    expect(screen.getByLabelText('Reps')).toHaveValue(5);
  });
});
