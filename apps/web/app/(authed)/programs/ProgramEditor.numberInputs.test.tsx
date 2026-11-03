import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProgramEditor from './ProgramEditor';
import { createCustomProgram } from './actions';

// ProgramEditor statically imports the server-only ./actions module and next/navigation's
// router; both are stubbed so Save resolves without a network call.
jest.mock('./actions', () => ({
  createCustomProgram: jest.fn().mockResolvedValue({ id: 'saved-id' }),
  updateCustomProgram: jest.fn(),
  switchProgram: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

const SETS = 'Back Squat #1 Day 1 Week 1 sets';

async function renderWithOneLift(user: ReturnType<typeof userEvent.setup>) {
  render(
    <ProgramEditor
      mode="new"
      activeProgram={null}
      defaultWeightIncrement={null}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  );
  await user.type(screen.getByLabelText('Program Name'), 'Test');
  await user.selectOptions(screen.getByLabelText('Add lift to Day 1'), 'Back Squat');
}

// Regression coverage for #763: the numeric inputs used to store Number(e.target.value), so a
// cleared field became 0 (below min={1}) and Save sent sets: 0 for the API to reject.
describe('ProgramEditor — numeric inputs', () => {
  beforeEach(() => jest.mocked(createCustomProgram).mockClear());

  it('keeps the last valid value while a field is cleared', async () => {
    const user = userEvent.setup();
    await renderWithOneLift(user);

    await user.clear(screen.getByLabelText(SETS));
    expect(screen.getByLabelText(SETS)).toHaveValue(null);

    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(createCustomProgram).toHaveBeenCalledTimes(1));
    const specs = jest.mocked(createCustomProgram).mock.calls[0]?.[0].specs ?? [];
    expect(specs.find((s) => s.week === 1)?.sets).toBe(3);
  });

  it('commits a new in-range value as it is typed', async () => {
    const user = userEvent.setup();
    await renderWithOneLift(user);

    await user.clear(screen.getByLabelText(SETS));
    await user.type(screen.getByLabelText(SETS), '5');

    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(createCustomProgram).toHaveBeenCalledTimes(1));
    const specs = jest.mocked(createCustomProgram).mock.calls[0]?.[0].specs ?? [];
    expect(specs.find((s) => s.week === 1)?.sets).toBe(5);
  });

  it('restores the last valid value on blur when the field is left empty', async () => {
    const user = userEvent.setup();
    await renderWithOneLift(user);

    await user.clear(screen.getByLabelText(SETS));
    await user.tab();
    expect(screen.getByLabelText(SETS)).toHaveValue(3);
  });
});
