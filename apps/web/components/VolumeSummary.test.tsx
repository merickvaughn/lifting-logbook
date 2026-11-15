import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VolumeSummary from './VolumeSummary';

const column = (counts: [string, number][]) => [
  { label: 'Sets / week', volume: { week: 1, counts: counts.map(([key, sets]) => ({ key, sets })), uncounted: [] } },
];

describe('VolumeSummary (#1017)', () => {
  const renderSummary = () =>
    render(
      <VolumeSummary
        caption="Weekly working sets"
        muscles={column([['Chest', 3]])}
        patterns={column([['Horizontal Push', 3]])}
      />,
    );

  it('shows the muscle view first, with its toggle pressed', () => {
    renderSummary();
    expect(screen.getByRole('group', { name: 'Count sets by' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Muscles' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Patterns' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('table', { name: 'Weekly working sets by muscle group' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Chest' })).toBeInTheDocument();
  });

  it('switches to the pattern view and back', async () => {
    const user = userEvent.setup();
    renderSummary();

    await user.click(screen.getByRole('button', { name: 'Patterns' }));
    expect(screen.getByRole('button', { name: 'Patterns' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('table', { name: 'Weekly working sets by movement pattern' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Pattern' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Horizontal Push' })).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: 'Chest' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Muscles' }));
    expect(screen.getByRole('rowheader', { name: 'Chest' })).toBeInTheDocument();
  });
});
