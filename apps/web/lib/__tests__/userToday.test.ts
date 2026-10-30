jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

import { cookies } from 'next/headers';
import { calendarDayIn, TIME_ZONE_COOKIE } from '@/lib/calendarDay';
import { getUserToday } from '@/lib/userToday';

const mockedCookies = cookies as unknown as jest.Mock;

/** 9:30 pm on 30 October in Los Angeles (PDT, UTC-7) — already 31 October in UTC. */
const LA_EVENING = new Date('2026-10-31T04:30:00Z');

function cookieJar(zone: string | undefined) {
  return {
    get: (name: string) => (name === TIME_ZONE_COOKIE && zone !== undefined ? { name, value: zone } : undefined),
  };
}

// Time zones are passed explicitly rather than by mutating process.env.TZ, which Jest
// ignores mid-process on this repo's Windows setup (CLAUDE.md → Testing).
describe('calendarDayIn', () => {
  it('gives a user several hours west of UTC their own day late in the evening, not tomorrow', () => {
    expect(LA_EVENING.toISOString().slice(0, 10)).toBe('2026-10-31');
    expect(calendarDayIn('America/Los_Angeles', LA_EVENING)).toBe('2026-10-30');
  });

  it('gives a user east of UTC their day once it has started there', () => {
    // 23:30 UTC on 31 December is already 1 January in Tokyo (UTC+9).
    expect(calendarDayIn('Asia/Tokyo', new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });

  it('zero-pads the month and day', () => {
    expect(calendarDayIn('UTC', new Date('2026-03-05T12:00:00Z'))).toBe('2026-03-05');
  });

  it('falls back to the UTC day when no zone is known', () => {
    expect(calendarDayIn(undefined, LA_EVENING)).toBe('2026-10-31');
    expect(calendarDayIn('', LA_EVENING)).toBe('2026-10-31');
  });

  it('falls back to the UTC day for a zone Intl does not recognise', () => {
    expect(calendarDayIn('Not/AZone', LA_EVENING)).toBe('2026-10-31');
  });
});

describe('getUserToday', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: LA_EVENING });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reads the time zone the browser recorded', async () => {
    mockedCookies.mockResolvedValue(cookieJar('America/Los_Angeles'));
    await expect(getUserToday()).resolves.toBe('2026-10-30');
  });

  it('falls back to the UTC day when the cookie is missing', async () => {
    mockedCookies.mockResolvedValue(cookieJar(undefined));
    await expect(getUserToday()).resolves.toBe('2026-10-31');
  });

  it('falls back to the UTC day when the cookie holds an invalid zone', async () => {
    mockedCookies.mockResolvedValue(cookieJar('garbage'));
    await expect(getUserToday()).resolves.toBe('2026-10-31');
  });
});
