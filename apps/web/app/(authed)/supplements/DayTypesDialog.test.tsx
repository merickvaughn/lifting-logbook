import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STACK } from '@/lib/__tests__/supplementsTestStack';
import { DayTypesDialog } from './DayTypesDialog';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('@/lib/client-api', () => ({ updateSupplementSettings: jest.fn() }));
jest.mock('@/lib/log-client-error', () => ({ logClientError: jest.fn() }));
jest.mock('@/lib/calendarDay', () => ({ localToday: () => '2026-11-21' }));

import { updateSupplementSettings } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';

const setup = () => {
  const onCancel = jest.fn();
  const onDone = jest.fn();
  render(<DayTypesDialog stack={STACK} onCancel={onCancel} onDone={onDone} />);
  return { onCancel, onDone };
};

const nameOf = (n: number) => screen.getByLabelText(`Name of day type ${n}`) as HTMLInputElement;
const savedDayTypes = () => (updateSupplementSettings as jest.Mock).mock.calls[0][0].dayTypes as { id: string; name: string }[];

beforeEach(() => {
  jest.clearAllMocks();
  (updateSupplementSettings as jest.Mock).mockResolvedValue({});
});

describe('Edit days', () => {
  it('shows each day type and the cutoff as stored, each field labelled with its row', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Day types' })).toBeInTheDocument();
    expect([nameOf(1).value, nameOf(2).value]).toEqual(['Lift day', 'Rest day']);
    expect(screen.getByLabelText('Session time for Lift day')).toHaveValue('16:30');
    expect(screen.getByLabelText('Session time for Rest day')).toHaveValue('');
    expect(screen.getByLabelText('Caffeine cutoff')).toHaveValue('15:00');
  });

  it('saves a rename, a new day, a removed day, a session time and the cutoff in one PUT', async () => {
    const { onDone } = setup();
    await userEvent.clear(nameOf(1));
    await userEvent.paste('Heavy day');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Rest day' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add day type' }));
    const added = nameOf(2);
    expect(added.value).toBe('New day');
    expect(added).toHaveFocus();
    await userEvent.clear(added);
    await userEvent.paste('Long run');
    await userEvent.type(screen.getByLabelText('Session time for Long run'), '07:15');
    await userEvent.clear(screen.getByLabelText('Caffeine cutoff'));
    await userEvent.type(screen.getByLabelText('Caffeine cutoff'), '14:00');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [settings, day] = (updateSupplementSettings as jest.Mock).mock.calls[0];
    expect(day).toBe('2026-11-21');
    expect(settings.caffeineCutoff).toBe('14:00');
    expect(settings.dayTypes).toEqual([
      { id: 'lift', name: 'Heavy day', sessionTime: '16:30' },
      { id: expect.any(String), name: 'Long run', sessionTime: '07:15' },
    ]);
    expect(onDone).toHaveBeenCalledWith(settings);
    expect(refresh).toHaveBeenCalled();
  });

  it('never gives a new day type the id of one removed (the API keeps doses on a day type by id)', async () => {
    const onDone = jest.fn();
    // A stored id shaped like the ones a counter would make, so reuse would show.
    const stack = { ...STACK, dayTypes: [STACK.dayTypes[0], { id: 'day-2', name: 'Long run' }] };
    render(<DayTypesDialog stack={stack} onCancel={jest.fn()} onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Long run' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add day type' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const ids = savedDayTypes().map((d) => d.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('lift');
    expect(['lift', 'day-2']).not.toContain(ids[1]);
  });

  it('gives two new day types different ids even after one is removed between them', async () => {
    const { onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: '+ Add day type' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add day type' }));
    const firstAdded = nameOf(3);
    await userEvent.clear(firstAdded);
    await userEvent.paste('Gone');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Gone' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add day type' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const ids = savedDayTypes().map((d) => d.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('moves focus to the next row’s ×, then the previous one, then + Add day type as rows go', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Lift day' }));
    expect(screen.getByRole('button', { name: 'Remove Rest day' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: '+ Add day type' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove New day' }));
    expect(screen.getByRole('button', { name: 'Remove Rest day' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Rest day' }));
    expect(screen.getByRole('button', { name: '+ Add day type' })).toHaveFocus();
  });

  it('shows the API’s 400 message, logs it, and keeps what was entered', async () => {
    const err = Object.assign(new Error('Removing “Lift day” leaves Creatine monohydrate on no day'), { status: 400 });
    (updateSupplementSettings as jest.Mock).mockRejectedValue(err);
    const { onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Lift day' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('leaves Creatine monohydrate on no day');
    expect(logClientError).toHaveBeenCalledWith('supplements.editDays', err, { dayTypes: 1 });
    expect(screen.queryByLabelText('Name of day type 2')).not.toBeInTheDocument();
    expect(nameOf(1).value).toBe('Rest day');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows a generic message for any other failure and keeps the input', async () => {
    (updateSupplementSettings as jest.Mock).mockRejectedValue(new Error('down'));
    setup();
    await userEvent.clear(screen.getByLabelText('Caffeine cutoff'));
    await userEvent.type(screen.getByLabelText('Caffeine cutoff'), '13:00');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('What you entered is still here');
    expect(screen.getByLabelText('Caffeine cutoff')).toHaveValue('13:00');
    expect(logClientError).toHaveBeenCalled();
  });

  it('locks Save, Cancel and Close while the save is in flight', async () => {
    let finish: (v: unknown) => void = () => {};
    (updateSupplementSettings as jest.Mock).mockReturnValue(new Promise((r) => (finish = r)));
    const { onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    finish({});
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(updateSupplementSettings).toHaveBeenCalledTimes(1);
  });

  it('refuses a name of only spaces before any request', async () => {
    setup();
    await userEvent.clear(nameOf(1));
    await userEvent.paste('   ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Every day type needs a name.');
    expect(updateSupplementSettings).not.toHaveBeenCalled();
  });

  it('refuses an empty caffeine cutoff before any request', async () => {
    setup();
    await userEvent.clear(screen.getByLabelText('Caffeine cutoff'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Set a caffeine cutoff time.');
    expect(updateSupplementSettings).not.toHaveBeenCalled();
  });
});
