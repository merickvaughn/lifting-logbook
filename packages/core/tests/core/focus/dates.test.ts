import { blockRange, blockStatus, daysLeft, nextStart, parseIsoDate, rangeLabel } from '@src/core';
import { block } from './focusFixtures';

describe('block dates', () => {
  it('snaps a calendar quarter to the quarter containing the start', () => {
    const b = { start: '2026-11-15', period: 'quarterly', align: 'calendar' } as const;
    expect(blockRange(b)).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(rangeLabel(b)).toBe('Q4 2026');
    expect(nextStart(b)).toBe('2027-01-01');
  });

  it('snaps a calendar month to the month containing the start', () => {
    const b = { start: '2026-02-12', period: 'monthly', align: 'calendar' } as const;
    expect(blockRange(b)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(rangeLabel(b)).toBe('February 2026');
    expect(nextStart(b)).toBe('2026-03-01');
  });

  it('runs a custom month from its start date across a year boundary', () => {
    const b = { start: '2026-12-12', period: 'monthly', align: 'custom' } as const;
    expect(blockRange(b)).toEqual({ start: '2026-12-12', end: '2027-01-11' });
    expect(rangeLabel(b)).toBe('Dec 12 – Jan 11');
    expect(nextStart(b)).toBe('2027-01-12');
  });

  it('runs a custom quarter from its start date across a year boundary', () => {
    const b = { start: '2026-11-20', period: 'quarterly', align: 'custom' } as const;
    expect(blockRange(b)).toEqual({ start: '2026-11-20', end: '2027-02-19' });
    expect(rangeLabel(b)).toBe('Nov 20 – Feb 19');
  });

  it('runs a custom block from the 1st to the end of the month', () => {
    const b = { start: '2026-10-01', period: 'monthly', align: 'custom' } as const;
    expect(blockRange(b)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
  });

  it.each([
    ['2027-01-31', 'monthly', '2027-02-28'],
    ['2027-01-30', 'monthly', '2027-02-28'],
    ['2027-01-29', 'monthly', '2027-02-28'],
    ['2028-01-31', 'monthly', '2028-02-29'],
    ['2028-01-30', 'monthly', '2028-02-29'],
    ['2026-11-30', 'quarterly', '2027-02-28'],
    ['2027-11-30', 'quarterly', '2028-02-29'],
  ] as const)('ends a custom %s %s block inside the target month (%s)', (start, period, end) => {
    expect(blockRange({ start, period, align: 'custom' }).end).toBe(end);
  });

  it('clamps a block that would end past the target month to its last day', () => {
    // The day before "Feb 31" would be "Feb 30", which Date would roll to Mar 2.
    const b = { start: '2027-01-31', period: 'monthly', align: 'custom' } as const;
    expect(rangeLabel(b)).toBe('Jan 31 – Feb 28');
    expect(nextStart(b)).toBe('2027-03-01');
  });

  it('rejects malformed and non-existent dates', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow(RangeError);
    expect(() => parseIsoDate('2026-1-5')).toThrow(RangeError);
    expect(() => blockStatus(block(), 'today')).toThrow(RangeError);
    expect(parseIsoDate('2028-02-29').toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('counts days left to the last day', () => {
    const b = block();
    expect(daysLeft(b, '2026-10-23')).toBe(69);
    expect(daysLeft(b, '2026-12-31')).toBe(0);
    expect(daysLeft(b, '2027-01-02')).toBe(-2);
  });

  it('derives status from dates, inclusive at both ends', () => {
    const b = block();
    expect(blockStatus(b, '2026-09-30')).toBe('queued');
    expect(blockStatus(b, '2026-10-01')).toBe('active');
    expect(blockStatus(b, '2026-12-31')).toBe('active');
    expect(blockStatus(b, '2027-01-01')).toBe('ended');
  });
});
