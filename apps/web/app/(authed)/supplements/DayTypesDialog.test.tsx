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

beforeEach(() => {
  jest.clearAllMocks();
  (updateSupplementSettings as jest.Mock).mockResolvedValue({});
});

describe('Edit days', () => {
  it('shows each day type and the cutoff as stored', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Day types' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('Name').map((i) => (i as HTMLInputElement).value)).toEqual(['Lift day', 'Rest day']);
    expect(screen.getAllByLabelText('Session time').map((i) => (i as HTMLInputElement).value)).toEqual(['16:30', '']);
    expect(screen.getByLabelText('Caffeine cutoff')).toHaveValue('15:00');
  });

  it('saves a rename, a new day, a removed day, a session time and the cutoff in one PUT', async () => {
    const { onDone } = setup();
    const names = screen.getAllByLabelText('Name');
    await userEvent.clear(names[0]);
    await userEvent.paste('Heavy day');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Rest day' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add day type' }));
    const added = screen.getAllByLabelText('Name')[1] as HTMLInputElement;
    expect(added.value).toBe('New day');
    await userEvent.clear(added);
    await userEvent.paste('Long run');
    await userEvent.type(screen.getAllByLabelText('Session time')[1], '07:15');
    await userEvent.clear(screen.getByLabelText('Caffeine cutoff'));
    await userEvent.type(screen.getByLabelText('Caffeine cutoff'), '14:00');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['lift', 'day-2']));
    expect(updateSupplementSettings).toHaveBeenCalledWith(
      {
        dayTypes: [
          { id: 'lift', name: 'Heavy day', sessionTime: '16:30' },
          { id: 'day-2', name: 'Long run', sessionTime: '07:15' },
        ],
        caffeineCutoff: '14:00',
      },
      '2026-11-21',
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the API’s 400 message, logs it, and keeps what was entered', async () => {
    const err = Object.assign(new Error('Removing “Lift day” leaves Creatine monohydrate on no day'), { status: 400 });
    (updateSupplementSettings as jest.Mock).mockRejectedValue(err);
    const { onDone } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Lift day' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('leaves Creatine monohydrate on no day');
    expect(logClientError).toHaveBeenCalledWith('supplements.editDays', err, { dayTypes: 1 });
    expect(screen.getAllByLabelText('Name')).toHaveLength(1);
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

  it('refuses a blank name before any request', async () => {
    setup();
    await userEvent.clear(screen.getAllByLabelText('Name')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(updateSupplementSettings).not.toHaveBeenCalled();
  });
});
