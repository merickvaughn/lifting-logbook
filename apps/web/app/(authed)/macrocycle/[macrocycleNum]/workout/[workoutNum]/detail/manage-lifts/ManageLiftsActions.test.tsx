import { render, screen, waitFor } from '@testing-library/react';
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
