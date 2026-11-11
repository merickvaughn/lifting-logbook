import { localToday } from '../calendarDay';

describe('localToday', () => {
  it("is the browser's local calendar day, zero-padded", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  // With the 23:59 case, this catches a regression to the UTC day (`toISOString()`) on
  // any host not on UTC: just after local midnight is the previous UTC day east of UTC,
  // and just before it is the next UTC day west of it (#1059).
  it('is the local day just after local midnight too', () => {
    expect(localToday(new Date(2026, 9, 23, 0, 30))).toBe('2026-10-23');
  });
});
