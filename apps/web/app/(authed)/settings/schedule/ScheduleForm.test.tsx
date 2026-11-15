import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserSettingsResponse } from '@lifting-logbook/types';
import ScheduleForm, { redateMessage } from './ScheduleForm';
import { redateMacrocycle, saveSchedule } from './actions';
import { logClientError } from '@/lib/log-client-error';

jest.mock('./actions', () => ({
  saveSchedule: jest.fn(),
  redateMacrocycle: jest.fn(),
}));
jest.mock('@/lib/log-client-error', () => ({
  logClientError: jest.fn(),
}));

const mockSave = saveSchedule as jest.MockedFunction<typeof saveSchedule>;
const mockRedate = redateMacrocycle as jest.MockedFunction<typeof redateMacrocycle>;
const mockLog = logClientError as jest.MockedFunction<typeof logClientError>;

const saved = (workoutSchedule: UserSettingsResponse['workoutSchedule']): UserSettingsResponse => ({
  activeProgram: '5-3-1',
  workoutSchedule,
  defaultWeightIncrement: null,
  unit: null,
  defaultProgression: null,
});

const REDATE_BOX = { name: /re-date the workouts left in my current macrocycle/i };

describe('ScheduleForm re-dating the current macrocycle (#1032)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-dates the active program’s macrocycle from the local date after saving, and says what changed', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue(saved({ type: 'fixed', days: [1, 3] }));
    mockRedate.mockResolvedValue({ macrocycleNum: 1, scheduled: true, redated: 21, firstDate: '2026-05-21', kept: 2 });
    render(<ScheduleForm initialSchedule={{ type: 'fixed', days: [0, 2, 4] }} activeProgram="5-3-1" />);

    expect(screen.getByRole('checkbox', REDATE_BOX)).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(mockSave).toHaveBeenCalledWith({ workoutSchedule: { type: 'fixed', days: [0, 2, 4] } });
    expect(mockRedate).toHaveBeenCalledWith('5-3-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Re-dated 21 workouts in your current macrocycle, starting Thu, May 21/,
    );
  });

  it('does not re-date when the lifter unticks the box', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue(saved(null));
    render(<ScheduleForm initialSchedule={null} activeProgram="5-3-1" />);

    await user.click(screen.getByRole('checkbox', REDATE_BOX));
    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByText(/Saved at/)).toBeInTheDocument();
    expect(mockRedate).not.toHaveBeenCalled();
  });

  it('offers no re-dating without an active program', () => {
    render(<ScheduleForm initialSchedule={null} activeProgram={null} />);
    expect(screen.queryByRole('checkbox', REDATE_BOX)).not.toBeInTheDocument();
  });

  it('says there was nothing to re-date when the program has no current macrocycle', async () => {
    const user = userEvent.setup();
    mockSave.mockResolvedValue(saved(null));
    mockRedate.mockResolvedValue({ macrocycleNum: null, scheduled: false, redated: 0, firstDate: null, kept: 0 });
    render(<ScheduleForm initialSchedule={null} activeProgram="5-3-1" />);

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/no current macrocycle/);
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeEnabled();
  });

  it('says the schedule saved and logs the error when re-dating fails', async () => {
    const user = userEvent.setup();
    const err = new Error('boom');
    mockSave.mockResolvedValue(saved(null));
    mockRedate.mockRejectedValue(err);
    render(<ScheduleForm initialSchedule={null} activeProgram="5-3-1" />);

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Your schedule is saved, but re-dating/);
    expect(mockLog).toHaveBeenCalledWith('redateMacrocycle', err, { program: '5-3-1' });
  });

  it('does not re-date when saving the schedule fails', async () => {
    const user = userEvent.setup();
    mockSave.mockRejectedValue(new Error('Request failed: 500'));
    render(<ScheduleForm initialSchedule={null} activeProgram="5-3-1" />);

    await user.click(screen.getByRole('button', { name: 'Save schedule' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed: 500');
    expect(mockRedate).not.toHaveBeenCalled();
  });
});

describe('redateMessage (#1032)', () => {
  it.each<[string, Parameters<typeof redateMessage>[0], RegExp]>([
    ['no current macrocycle', { macrocycleNum: null, scheduled: true, redated: 0, firstDate: null, kept: 0 }, /no current macrocycle/],
    ['cleared, nothing done', { macrocycleNum: 1, scheduled: false, redated: 0, firstDate: null, kept: 0 }, /no longer scheduled\.$/],
    ['cleared, some done', { macrocycleNum: 1, scheduled: false, redated: 0, firstDate: null, kept: 3 }, /The 3 you've logged or skipped keep their scheduled dates/],
    ['scheduled, all done', { macrocycleNum: 1, scheduled: true, redated: 0, firstDate: null, kept: 24 }, /none were re-dated/],
    ['scheduled, one left', { macrocycleNum: 1, scheduled: true, redated: 1, firstDate: '2026-05-22', kept: 23 }, /Re-dated 1 workout in/],
  ])('%s', (_label, result, expected) => {
    expect(redateMessage(result)).toMatch(expected);
  });
});
