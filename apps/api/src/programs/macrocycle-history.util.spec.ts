import { Logger } from '@nestjs/common';
import { InMemoryLiftRecordRepository } from '../adapters/in-memory/lift-record.adapter';
import { InMemoryMacrocycleDashboardRepository } from '../adapters/in-memory/macrocycle-dashboard.adapter';
import { InMemoryMacrocycleRepository } from '../adapters/in-memory/macrocycle.adapter';
import { MacrocycleNumberConflictError } from '../ports/errors';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import {
  closingStatus,
  datesAsRead,
  legacyRowsPreImage,
  placeFileRows,
  splitLegacyRowKeys,
  STALE_AFTER_DAYS,
  statusAsRead,
} from './macrocycle-history.util';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('placeFileRows', () => {
  it('logs a refused move of rows saved before initializing, as the renumbering logs its refusals', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const liftRecord = new InMemoryLiftRecordRepository(new Map());
      // A set on number 1 with no macrocycle row, which the new legacy macrocycle 1 must move past.
      await liftRecord.appendLiftRecords('5-3-1', [
        { program: '5-3-1', macrocycleNum: 1, workoutNum: 1, date: day('2026-01-05'), lift: 'Squat', setNum: 1, weight: 200, reps: 5, notes: '' },
      ]);
      const macrocycle = new InMemoryMacrocycleRepository();
      macrocycle.attachNumbered([liftRecord]);
      const refused = new MacrocycleNumberConflictError('5-3-1', undefined, { table: 'lift_record', heldNumber: 2 });
      jest.spyOn(macrocycle, 'rewriteNumbers').mockRejectedValue(refused);
      const repos = { macrocycle, liftRecord, macrocycleDashboard: new InMemoryMacrocycleDashboardRepository() };

      await expect(
        placeFileRows(repos, '5-3-1', [{ macrocycleNum: 4, date: day('2025-03-03') }], new Map()),
      ).rejects.toBe(refused);

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ program: '5-3-1', moves: { 1: 2 }, table: 'lift_record', heldNumber: 2 }),
        'Moving unstarted rows failed',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

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
  const workouts = (...nums: number[]) => new Set(nums);
  const first = (n: number) => workouts(...Array.from({ length: n }, (_, i) => i + 1));

  it('is completed once every workout has a logged set', () => {
    expect(closingStatus(first(12), 12)).toBe('completed');
  });

  it('is abandoned with workouts left, since starting the next one is a restart', () => {
    expect(closingStatus(first(11), 12)).toBe('abandoned');
    expect(closingStatus(workouts(), 12)).toBe('abandoned');
  });

  it("doesn't count a workout number past the program's length towards it", () => {
    expect(closingStatus(workouts(...first(11), 13), 12)).toBe('abandoned');
  });

  it('is unknown when the program has no known length', () => {
    expect(closingStatus(first(3), 0)).toBe('unknown');
  });
});

describe('datesAsRead', () => {
  const stored = { startDate: day('2026-03-02'), endDate: day('2026-04-10') };

  it('keeps the stored dates when the sets fall inside them, or there are none', () => {
    expect(datesAsRead(stored, { first: day('2026-03-04'), last: day('2026-04-08') })).toEqual(stored);
    expect(datesAsRead(stored, undefined)).toEqual(stored);
  });

  it('widens to a set logged before the start or after the end', () => {
    expect(datesAsRead(stored, { first: day('2026-02-27'), last: day('2026-04-20') })).toEqual({
      startDate: day('2026-02-27'),
      endDate: day('2026-04-20'),
    });
  });

  it('leaves a missing end date missing', () => {
    expect(datesAsRead({ ...stored, endDate: null }, { first: day('2026-03-04'), last: day('2026-05-01') }).endDate).toBeNull();
  });
});

describe('legacy rows in an import pre-image', () => {
  it("round-trips the numbers apart from the sets' natural keys", () => {
    const keys = ['3:1:20260302:squat:1', ...Object.keys(legacyRowsPreImage([3, 5]))];
    expect(splitLegacyRowKeys(keys)).toEqual({ setKeys: ['3:1:20260302:squat:1'], legacyNums: [3, 5] });
  });
});
