import 'server-only';

import { cache } from 'react';
import { cookies } from 'next/headers';
import { calendarDayIn, TIME_ZONE_COOKIE } from './calendarDay';

/**
 * The user's calendar day as an ISO date, for Server Components and Server Actions.
 *
 * The server's own clock is UTC, which for a user west of UTC is tomorrow every evening
 * (#1072). The browser records its time zone in a cookie (`TimeZoneCookie`), and this reads
 * it; a request without one (the very first page load, or cookies blocked) falls back to
 * the UTC day. `cache()`d so every component in one render agrees on the day.
 */
export const getUserToday = cache(async (): Promise<string> => {
  const zone = (await cookies()).get(TIME_ZONE_COOKIE)?.value;
  return calendarDayIn(zone);
});
