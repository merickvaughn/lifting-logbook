import { BadRequestException } from '@nestjs/common';
import { parseWriteToday } from './iso-date-param';

describe('parseWriteToday', () => {
  // 23:30 UTC on 20 November: already 21 November in UTC+14, still 20 November in UTC−12.
  const now = new Date('2026-11-20T23:30:00Z');

  it('accepts dates up to a day past the server’s UTC date, and any earlier date', () => {
    for (const today of ['2026-11-21', '2026-11-20', '2026-11-19', '2020-01-01']) {
      expect(parseWriteToday(today, now)).toBe(today);
    }
  });

  it('refuses a date more than a day past the server’s UTC date', () => {
    for (const today of ['2026-11-22', '2027-11-20', '2099-01-01']) {
      expect(() => parseWriteToday(today, now)).toThrow(BadRequestException);
    }
    expect(() => parseWriteToday('2026-11-22', now)).toThrow(/the latest it can be is 2026-11-21/);
  });

  it('still requires an ISO date', () => {
    for (const today of [undefined, '', '2026-11-31', '20261120']) {
      expect(() => parseWriteToday(today, now)).toThrow(BadRequestException);
    }
  });
});
