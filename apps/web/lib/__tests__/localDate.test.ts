import { localIsoDate } from '../localDate';

// Dates built from local fields sit at the edges of a local day. Near midnight the UTC day
// differs on any host not on UTC: 00:30 falls on the previous UTC day east of UTC, and 23:30
// on the next UTC day west of it. So a regression to `toISOString()` fails one of these on
// every non-UTC host (Linux CI runs in UTC, where the two agree and can't tell them apart).
describe('localIsoDate', () => {
  it('gives the local calendar day just after local midnight', () => {
    expect(localIsoDate(new Date(2026, 9, 23, 0, 30))).toBe('2026-10-23');
  });

  it('gives the local calendar day just before local midnight', () => {
    expect(localIsoDate(new Date(2026, 9, 23, 23, 30))).toBe('2026-10-23');
  });

  it('pads the month and day', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });
});
