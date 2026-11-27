import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_SET_OCCURRENCE } from '@lifting-logbook/core';
import type { CreateLiftRecordRequest } from '@lifting-logbook/types';
import ComplexCard from './ComplexCard';
import type { ComplexSlot } from './types';
import { createLiftRecord, deleteLiftRecord } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

jest.mock('@/lib/client-api', () => ({
  createLiftRecord: jest.fn(),
  deleteLiftRecord: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));

const mockedCreate = jest.mocked(createLiftRecord);
const mockedDelete = jest.mocked(deleteLiftRecord);

const BEAR: ComplexSlot['complex'] = {
  found: true,
  name: 'Bear',
  components: [
    { lift: 'Deadlift', reps: 1, name: 'Deadlift' },
    { lift: 'front-squat', reps: 2, name: 'Front Squat' },
  ],
  limitingLift: 'Front Squat',
  missing: [],
};

function slot(overrides: Partial<ComplexSlot> = {}): ComplexSlot {
  return { complex: BEAR, tm: 150, workWeights: [135], ordinal: 0, logged: [], ...overrides };
}

function renderCard(s = slot()) {
  render(
    <ComplexCard slot={s} program="p1" macrocycleNum={2} macrocycleId="m-2" workoutNum={3} date="2026-11-27" unit="lbs" />,
  );
}

/** What each create call sent, without the fields every one of them shares. */
function sent() {
  return mockedCreate.mock.calls.map(([, body]) => {
    const { lift, occurrence, setNum, weight, reps, complex, complexRound } = body as CreateLiftRecordRequest;
    return { lift, occurrence, setNum, weight, reps, complex, complexRound };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreate.mockImplementation(async (_program, body) => ({
    ...body,
    id: `id-${body.complexRound}-${body.setNum}`,
    amrap: false,
    notes: '',
  }) as never);
  mockedDelete.mockResolvedValue(undefined);
});

describe('ComplexCard (#1496)', () => {
  it('saves one set per lift per round, tagged with the complex and its round, at the card’s weight', async () => {
    const user = userEvent.setup();
    renderCard();

    // Prefilled from the planned weight; changed once for the whole complex.
    const weight = screen.getByLabelText('Weight (lbs) for Bear');
    expect(weight).toHaveValue(135);
    await user.clear(weight);
    await user.type(weight, '145');
    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    // Each round's reps start from the definition.
    expect(screen.getByLabelText('Bear round 2 Front Squat reps')).toHaveValue(2);
    await user.click(screen.getByRole('button', { name: 'Save Bear rounds' }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(4));
    const at = { weight: 145, complex: 'Bear', occurrence: MAX_SET_OCCURRENCE };
    expect(sent()).toEqual([
      { ...at, lift: 'Deadlift', setNum: 1, reps: 1, complexRound: 1 },
      { ...at, lift: 'front-squat', setNum: 2, reps: 2, complexRound: 1 },
      { ...at, lift: 'Deadlift', setNum: 3, reps: 1, complexRound: 2 },
      { ...at, lift: 'front-squat', setNum: 4, reps: 2, complexRound: 2 },
    ]);
    expect(mockedCreate.mock.calls[0]).toEqual([
      'p1',
      expect.objectContaining({ program: 'p1', macrocycleNum: 2, workoutNum: 3, date: '2026-11-27' }),
      'm-2',
    ]);
    const rounds = within(await screen.findByRole('list', { name: 'Bear logged rounds' }));
    expect(rounds.getByText('Round 2: Deadlift × 1, Front Squat × 2 at 145 lbs')).toBeInTheDocument();
  });

  it('saves a round’s edited reps for that round only', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    const reps = screen.getByLabelText('Bear round 2 Front Squat reps');
    await user.clear(reps);
    await user.type(reps, '1');
    await user.click(screen.getByRole('button', { name: 'Save Bear rounds' }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(4));
    expect(sent().map((s) => [s.complexRound, s.lift, s.reps])).toEqual([
      [1, 'Deadlift', 1],
      [1, 'front-squat', 2],
      [2, 'Deadlift', 1],
      [2, 'front-squat', 1],
    ]);
  });

  it('deletes a logged round’s sets, and only that round’s', async () => {
    const user = userEvent.setup();
    const set = { weight: 135, reps: 1 };
    renderCard(
      slot({
        logged: [
          { ...set, id: 'r1-d', setNum: 1, lift: 'Deadlift', complexRound: 1 },
          { ...set, id: 'r1-f', setNum: 2, lift: 'front-squat', complexRound: 1 },
          { ...set, id: 'r2-d', setNum: 3, lift: 'Deadlift', complexRound: 2 },
          { ...set, id: 'r2-f', setNum: 4, lift: 'front-squat', complexRound: 2 },
        ],
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Remove Bear round 2' }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledTimes(2));
    expect(mockedDelete.mock.calls).toEqual([
      ['p1', 'r2-d', 'm-2'],
      ['p1', 'r2-f', 'm-2'],
    ]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Bear round 2' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Remove Bear round 1' })).toBeInTheDocument();
    // The next round added follows the rounds still logged.
    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    expect(screen.getByLabelText('Bear round 2 Deadlift reps')).toBeInTheDocument();
  });

  it('numbers a new round after the logged ones, and starts the weight from them', async () => {
    const user = userEvent.setup();
    renderCard(slot({ logged: [{ id: 'r1-d', setNum: 1, weight: 155, reps: 1, lift: 'Deadlift', complexRound: 1 }] }));

    expect(screen.getByLabelText('Weight (lbs) for Bear')).toHaveValue(155);
    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    await user.click(screen.getByRole('button', { name: 'Save Bear rounds' }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(2));
    expect(sent().map((s) => [s.complexRound, s.setNum])).toEqual([
      [2, 3],
      [2, 4],
    ]);
  });

  it('reports a failed save through logClientError and keeps the round to save again', async () => {
    const user = userEvent.setup();
    const failure = new Error('network down');
    mockedCreate.mockRejectedValueOnce(failure);
    renderCard();

    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    await user.click(screen.getByRole('button', { name: 'Save Bear rounds' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save round 1. Try again.');
    expect(logClientError).toHaveBeenCalledWith('createLiftRecord', failure, expect.objectContaining({ complex: 'Bear', round: 1 }));
    expect(screen.getByLabelText('Bear round 1 Deadlift reps')).toBeInTheDocument();
  });

  it('sends only the unsaved sets on a retry after a round failed part way, at the locked weight and reps', async () => {
    const user = userEvent.setup();
    const failure = new Error('network down');
    mockedCreate.mockImplementationOnce(async (_program, body) => ({ ...body, id: 'saved-deadlift', amrap: false, notes: '' }) as never);
    mockedCreate.mockRejectedValueOnce(failure);
    renderCard();

    await user.click(screen.getByRole('button', { name: 'Add a round of Bear' }));
    await user.click(screen.getByRole('button', { name: 'Save Bear rounds' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save round 1. Try again.');

    // The saved Deadlift set is at this weight and these reps, so neither can change now.
    expect(screen.getByLabelText('Weight (lbs) for Bear')).toBeDisabled();
    expect(screen.getByLabelText('Bear round 1 Deadlift reps')).toBeDisabled();
    expect(screen.getByLabelText('Bear round 1 Front Squat reps')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save Bear rounds' }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(3));
    expect(sent().map((s) => [s.lift, s.setNum])).toEqual([
      ['Deadlift', 1],
      ['front-squat', 2],
      ['front-squat', 2],
    ]);
    const rounds = within(await screen.findByRole('list', { name: 'Bear logged rounds' }));
    expect(rounds.getByText('Round 1: Deadlift × 1, Front Squat × 2 at 135 lbs')).toBeInTheDocument();
    expect(screen.queryByLabelText('Bear round 1 Deadlift reps')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Weight (lbs) for Bear')).toBeEnabled();
  });

  it('moves focus to Add a round, and says what happened, after a save, a discard and a removal', async () => {
    const user = userEvent.setup();
    renderCard();
    const add = screen.getByRole('button', { name: 'Add a round of Bear' });

    await user.click(add);
    await user.click(screen.getByRole('button', { name: 'Save Bear rounds' }));
    await waitFor(() => expect(add).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Saved round 1.');

    await user.click(add);
    await user.click(screen.getByRole('button', { name: 'Discard Bear round 2' }));
    expect(add).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Discarded round 2.');

    await user.click(screen.getByRole('button', { name: 'Remove Bear round 1' }));
    await waitFor(() => expect(add).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent('Removed round 1.');
  });

  it('reports a failed delete through logClientError and keeps the round', async () => {
    const user = userEvent.setup();
    const failure = new Error('network down');
    mockedDelete.mockRejectedValueOnce(failure);
    renderCard(slot({ logged: [{ id: 'r1-d', setNum: 1, weight: 135, reps: 1, lift: 'Deadlift', complexRound: 1 }] }));

    await user.click(screen.getByRole('button', { name: 'Remove Bear round 1' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to remove round 1. Try again.');
    expect(logClientError).toHaveBeenCalledWith('deleteLiftRecord', failure, expect.objectContaining({ id: 'r1-d' }));
    expect(screen.getByRole('button', { name: 'Remove Bear round 1' })).toBeInTheDocument();
  });

  it('offers no logging for a complex it can’t find', () => {
    renderCard(slot({ complex: { ...BEAR, found: false } }));
    expect(screen.queryByRole('button', { name: 'Add a round of Bear' })).not.toBeInTheDocument();
  });
});
