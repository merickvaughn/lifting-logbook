import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProgramEditor from './ProgramEditor';
import { createCustomProgram } from './actions';

// Stubbed as in ProgramEditor.numberInputs.test.tsx, so Save resolves without a network call.
jest.mock('./actions', () => ({
  createCustomProgram: jest.fn().mockResolvedValue({ id: 'saved-id' }),
  updateCustomProgram: jest.fn(),
  switchProgram: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

const LOAD = (week: number) => `Back Squat #1 Day 1 Week ${week} load percent`;

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

async function savedSpecs(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(createCustomProgram).toHaveBeenCalledTimes(1));
  return jest.mocked(createCustomProgram).mock.calls[0]?.[0].specs ?? [];
}

// #1526: a row's load percentage, edited as a whole percent and sent as a fraction.
describe('ProgramEditor — load percentage', () => {
  beforeEach(() => jest.mocked(createCustomProgram).mockClear());

  it('starts blank, and sends null for a row that plans from the whole max', async () => {
    const user = userEvent.setup();
    await renderWithOneLift(user);
    expect(screen.getByLabelText(LOAD(1))).toHaveValue(null);
    const specs = await savedSpecs(user);
    expect(specs.map((s) => s.loadPct)).toEqual([null, null, null]);
  });

  it('sends a typed percent as a fraction for that week only', async () => {
    const user = userEvent.setup();
    await renderWithOneLift(user);
    await user.type(screen.getByLabelText(LOAD(2)), '70');
    const specs = await savedSpecs(user);
    expect(specs.map((s) => [s.week, s.loadPct])).toEqual([
      [1, null],
      [2, 0.7],
      [3, null],
    ]);
  });

  it('clamps an entry above 100 to 100, and clears back to none', async () => {
    const user = userEvent.setup();
    await renderWithOneLift(user);
    await user.type(screen.getByLabelText(LOAD(1)), '150');
    await user.tab();
    expect(screen.getByLabelText(LOAD(1))).toHaveValue(100);

    await user.clear(screen.getByLabelText(LOAD(1)));
    const specs = await savedSpecs(user);
    expect(specs.find((s) => s.week === 1)?.loadPct).toBeNull();
  });
});
