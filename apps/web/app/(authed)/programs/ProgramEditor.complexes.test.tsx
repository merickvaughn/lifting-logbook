import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BarbellComplexResponse, CustomProgramResponse } from '@lifting-logbook/types';
import ProgramEditor from './ProgramEditor';
import { createCustomProgram } from './actions';

jest.mock('./actions', () => ({
  createCustomProgram: jest.fn(),
  updateCustomProgram: jest.fn(),
  switchProgram: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

const BEAR: BarbellComplexResponse = {
  id: 'c-bear',
  name: 'Bear',
  components: [
    { lift: 'Deadlift', reps: 5, name: 'Deadlift' },
    { lift: 'Front Squat', reps: 5, name: 'Front Squat' },
  ],
  createdAt: '2026-11-27T00:00:00.000Z',
};

describe('ProgramEditor — a row can plan a complex (#1495)', () => {
  it('offers the complexes beside the lifts, shows the chosen one by name, and saves it as complex:<id>', async () => {
    const user = userEvent.setup();
    jest.mocked(createCustomProgram).mockResolvedValue({ id: 'p1' } as CustomProgramResponse);
    const onSaved = jest.fn();
    render(
      <ProgramEditor
        mode="new"
        activeProgram={null}
        defaultWeightIncrement={5}
        complexes={[BEAR]}
        onSaved={onSaved}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole('group', { name: 'Complexes' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Add lift to Day 1'), 'Bear');
    expect(screen.getByText('Bear', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByLabelText('Bear #1 Day 1 Week 1 sets')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Program Name'), 'Complex day');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('p1'));
    const sent = jest.mocked(createCustomProgram).mock.calls[0]?.[0];
    expect(new Set(sent?.specs.map((s) => s.lift))).toEqual(new Set(['complex:c-bear']));
  });

  it('offers no complex group when the lifter has none', () => {
    render(
      <ProgramEditor mode="new" activeProgram={null} defaultWeightIncrement={5} onSaved={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByRole('group', { name: 'Complexes' })).not.toBeInTheDocument();
  });

  it('links to Settings → Complexes in a new tab when the lifter has none (#1506)', () => {
    render(
      <ProgramEditor
        mode="new"
        activeProgram={null}
        defaultWeightIncrement={5}
        complexes={[]}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    const link = screen.getByRole('link', { name: 'Settings → Complexes' });
    expect(link).toHaveAttribute('href', '/settings/complexes');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('leaves the link out once a complex exists, or when the complexes couldn’t be read', () => {
    const { rerender } = render(
      <ProgramEditor
        mode="new"
        activeProgram={null}
        defaultWeightIncrement={5}
        complexes={[BEAR]}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Settings → Complexes' })).not.toBeInTheDocument();
    rerender(
      <ProgramEditor
        mode="new"
        activeProgram={null}
        defaultWeightIncrement={5}
        complexes={null}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Settings → Complexes' })).not.toBeInTheDocument();
  });

  it('names a row whose complex was deleted as such, rather than by its id', () => {
    const existing: CustomProgramResponse = {
      id: 'p1',
      name: 'Old',
      description: null,
      baseTemplate: null,
      createdAt: '2026-11-27T00:00:00.000Z',
      specs: [
        {
          week: 1,
          offset: 0,
          lift: 'complex:gone',
          increment: 5,
          order: 1,
          sets: 3,
          reps: 5,
          amrap: false,
          warmUpPct: '',
          wtDecrementPct: 0,
          activation: 'none',
        },
      ],
    };
    render(
      <ProgramEditor
        mode="edit"
        existing={existing}
        activeProgram={null}
        defaultWeightIncrement={5}
        complexes={[BEAR]}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Deleted complex', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText('complex:gone')).not.toBeInTheDocument();
  });

  it('says a row’s complex couldn’t load, not that it was deleted, when the complexes couldn’t be read', () => {
    const existing: CustomProgramResponse = {
      id: 'p1',
      name: 'Old',
      description: null,
      baseTemplate: null,
      createdAt: '2026-11-27T00:00:00.000Z',
      specs: [
        {
          week: 1,
          offset: 0,
          lift: 'complex:c-bear',
          increment: 5,
          order: 1,
          sets: 3,
          reps: 5,
          amrap: false,
          warmUpPct: '',
          wtDecrementPct: 0,
          activation: 'none',
        },
      ],
    };
    render(
      <ProgramEditor
        mode="edit"
        existing={existing}
        activeProgram={null}
        defaultWeightIncrement={5}
        complexes={null}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Complex (couldn’t load)', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText('Deleted complex')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Complexes' })).not.toBeInTheDocument();
  });
});
