import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ManageLiftsActions from './ManageLiftsActions';
import { upsertLiftOverride } from '@/lib/client-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn() }),
}));

jest.mock('@/lib/client-api', () => ({
  upsertLiftOverride: jest.fn(),
}));

const mockUpsert = upsertLiftOverride as jest.MockedFunction<typeof upsertLiftOverride>;

// A day that plans Squat twice lists it twice (#1027).
const lifts = [
  { lift: 'Squat', sets: [], planned: true },
  { lift: 'Bench Press', sets: [], planned: true },
  { lift: 'Squat', sets: [], planned: true, occurrence: 1 },
];

describe('ManageLiftsActions — a lift planned twice in a day (#1027)', () => {
  it('renders each occurrence as its own row, without a duplicate-key error', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<ManageLiftsActions program="my-program" macrocycleNum={1} workoutNum={1} lifts={lifts} />);
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('marks only the row being removed as pending', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    mockUpsert.mockReturnValue(new Promise((resolve) => (finish = () => resolve(undefined as never))));
    render(<ManageLiftsActions program="my-program" macrocycleNum={1} workoutNum={1} lifts={lifts} />);

    const [firstSquatRemove] = screen.getAllByRole('button', { name: 'Remove' });
    if (!firstSquatRemove) throw new Error('expected a Remove button per row');
    await user.click(firstSquatRemove);

    expect(screen.getAllByRole('button', { name: '…' })).toHaveLength(1);
    finish();
    await waitFor(() => expect(screen.queryByRole('button', { name: '…' })).not.toBeInTheDocument());
  });
});

describe('ManageLiftsActions — a complex slot (#1495)', () => {
  const withComplex = [
    { lift: 'Squat', sets: [], planned: true },
    { lift: 'complex:c-bear', sets: [], planned: true },
  ];

  it('names the complex, and offers no lift-metadata Edit for it', () => {
    render(
      <ManageLiftsActions
        program="my-program"
        macrocycleNum={1}
        workoutNum={1}
        lifts={withComplex}
        complexes={[{ id: 'c-bear', name: 'Bear' }]}
      />,
    );
    const [squat, bear] = screen.getAllByRole('listitem');
    expect(bear).toHaveTextContent('Bear');
    expect(screen.queryByText(/complex:/)).not.toBeInTheDocument();
    expect(within(squat as HTMLElement).getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(within(bear as HTMLElement).queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(bear as HTMLElement).getByRole('link', { name: 'Replace' })).toBeInTheDocument();
  });

  it('calls a complex it wasn’t given unknown, not by its id', () => {
    render(<ManageLiftsActions program="my-program" macrocycleNum={1} workoutNum={1} lifts={withComplex} />);
    expect(screen.getByText('Unknown complex')).toBeInTheDocument();
    expect(screen.queryByText(/complex:/)).not.toBeInTheDocument();
  });
});

describe('ManageLiftsActions — the macrocycle id (#1198)', () => {
  it('links Replace to the picker with the macrocycle id, so the picker needs no workout read', () => {
    render(<ManageLiftsActions program="my-program" macrocycleNum={1} macrocycleId="mc-a" workoutNum={1} lifts={lifts} />);
    const [replace] = screen.getAllByRole('link', { name: 'Replace' });
    expect(replace).toHaveAttribute(
      'href',
      '/macrocycle/1/workout/1/detail/manage-lifts/pick?action=replace&replacing=Squat&macrocycleId=mc-a',
    );
  });
});
