import { render, screen } from '@testing-library/react';
import { defaultPoolEntry } from '@lifting-logbook/core';
import type { FocusBlock } from '@lifting-logbook/types';
import { newFocusBlock } from '@/lib/focusSetup';
import FocusPoolRow from './FocusPoolRow';

const block = newFocusBlock('Shoulders', '2026-10-01') as FocusBlock;

function renderRow(lift: string) {
  render(
    <FocusPoolRow
      block={block}
      entry={defaultPoolEntry(lift)}
      programLifts={[]}
      unit="lbs"
      onChange={jest.fn()}
      onRemove={jest.fn()}
    />,
  );
}

// #1135: a pool can hold a lift under any spelling, and its muscles are the catalog's.
describe('FocusPoolRow muscle tags', () => {
  it.each(['Lateral Raise', 'lateral-raise', 'Lateral Raises'])('shows the catalog muscles for %s', (lift) => {
    renderRow(lift);
    expect(screen.getByText('Side Delts')).toBeInTheDocument();
  });

  it('shows none for a lift the catalog does not know', () => {
    renderRow('Some Custom Lift');
    expect(screen.queryByText('Side Delts')).not.toBeInTheDocument();
  });
});
