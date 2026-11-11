/**
 * The cookie the browser records its IANA time zone in (`TimeZoneCookie`), so the server
 * can work out the user's calendar day (`getUserToday`, #1072). Shared by both halves, and
 * kept out of the server-only module so the client component can import it.
 */
export const TIME_ZONE_COOKIE = 'tz';

/**
 * The ISO calendar day `now` falls on in `timeZone`. UTC when the zone is missing or is
 * not one `Intl` recognises — a hand-edited or stale cookie must not take a page down.
 */
export function calendarDayIn(timeZone: string | undefined, now: Date = new Date()): string {
  if (timeZone) {
    let parts: Intl.DateTimeFormatPart[] | undefined;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
    } catch (err) {
      // An unknown zone is a RangeError; anything else is a real bug.
      if (!(err instanceof RangeError)) throw err;
    }
    if (parts) {
      const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
      return `${part('year')}-${part('month')}-${part('day')}`;
    }
  }
  return now.toISOString().slice(0, 10);
}

/**
 * The user's calendar day as an ISO date, from the browser's own clock and time zone: the
 * client-side counterpart of `calendarDayIn`. Callers such as the focus endpoints pass it
 * as `?today=`, since the server cannot know the user's zone.
 */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
