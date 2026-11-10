import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import { closingStatus, STALE_AFTER_DAYS, statusAsRead } from './macrocycle-history.util';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const row = (overrides: Partial<MacrocycleRow> = {}): Pick<MacrocycleRow, 'status' | 'statusChosen' | 'startDate'> => ({
  status: 'in-progress',
  statusChosen: false,
  startDate: day('2026-09-01'),
  ...overrides,
});

describe('statusAsRead', () => {
  const today = day('2026-11-10');
  const daysBefore = (n: number) => new Date(today.getTime() - n * 24 * 60 * 60 * 1000);

  it('reads an in-progress row whose last session is over 14 days old as abandoned', () => {
    expect(statusAsRead(row(), { current: false, lastSession: daysBefore(STALE_AFTER_DAYS + 1), today })).toBe(
      'abandoned',
    );
  });

  it('keeps an in-progress row whose last session is exactly 14 days old', () => {
    expect(statusAsRead(row(), { current: false, lastSession: daysBefore(STALE_AFTER_DAYS), today })).toBe(
      'in-progress',
    );
  });

  it('keeps the macrocycle the dashboard points at in progress, however long the break', () => {
    expect(statusAsRead(row(), { current: true, lastSession: daysBefore(90), today })).toBe('in-progress');
  });

  it('keeps a status the lifter chose', () => {
    expect(
      statusAsRead(row({ statusChosen: true }), { current: false, lastSession: daysBefore(90), today }),
    ).toBe('in-progress');
  });

  it('dates a row with no sessions by its start', () => {
    expect(statusAsRead(row({ startDate: daysBefore(15) }), { current: false, lastSession: null, today })).toBe(
      'abandoned',
    );
    expect(statusAsRead(row({ startDate: daysBefore(3) }), { current: false, lastSession: null, today })).toBe(
      'in-progress',
    );
  });

  it.each(['completed', 'abandoned', 'overran', 'unknown'] as const)('leaves a %s row as stored', (status) => {
    expect(statusAsRead(row({ status }), { current: false, lastSession: daysBefore(90), today })).toBe(status);
  });

  it('ignores the time of day', () => {
    const lateToday = new Date('2026-11-10T23:30:00.000Z');
    expect(
      statusAsRead(row(), { current: false, lastSession: daysBefore(STALE_AFTER_DAYS), today: lateToday }),
    ).toBe('in-progress');
  });
});

describe('closingStatus', () => {
  it('is completed once every workout has a logged set', () => {
    expect(closingStatus(12, 12)).toBe('completed');
  });

  it('is abandoned with workouts left, since starting the next one is a restart', () => {
    expect(closingStatus(11, 12)).toBe('abandoned');
    expect(closingStatus(0, 12)).toBe('abandoned');
  });

  it('is unknown when the program has no known length', () => {
    expect(closingStatus(3, 0)).toBe('unknown');
  });
});
