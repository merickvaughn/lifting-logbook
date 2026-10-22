import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProgramEditor from './ProgramEditor';

// ProgramEditor statically imports the server-only ./actions module and next/navigation's
// router; neither is exercised by these tests (no Save click), so both are stubbed to keep
// this a pure client render of the spec-seeding behavior.
jest.mock('./actions', () => ({
  createCustomProgram: jest.fn(),
  updateCustomProgram: jest.fn(),
  switchProgram: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

function renderNew(defaultWeightIncrement: number | null) {
  render(
    <ProgramEditor
      mode="new"
      activeProgram={null}
      defaultWeightIncrement={defaultWeightIncrement}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  );
}

// A `new` program starts with one empty Day 1; adding an exercise to it seeds three
// week rows whose increment inputs carry the configured default.
async function addFirstLiftToDay1(user: ReturnType<typeof userEvent.setup>) {
  // 'Back Squat' is the first catalog lift; selecting by option value keeps this
  // independent of catalog ordering and avoids a non-null index assertion.
  await user.selectOptions(screen.getByLabelText('Add lift to Day 1'), 'Back Squat');
}

describe('ProgramEditor — new instances seed from the configured weight increment', () => {
  it('seeds a new lift instance with the user-configured default', async () => {
    const user = userEvent.setup();
    renderNew(0.625);
    await addFirstLiftToDay1(user);

    const incrementInputs = screen.getAllByDisplayValue('0.625');
    // One row per week (3) for the single added instance.
    expect(incrementInputs).toHaveLength(3);
  });

  it('falls back to 1.25 when no default is configured yet', async () => {
    const user = userEvent.setup();
    renderNew(null);
    await addFirstLiftToDay1(user);

    const incrementInputs = screen.getAllByDisplayValue('1.25');
    expect(incrementInputs).toHaveLength(3);
  });
});
