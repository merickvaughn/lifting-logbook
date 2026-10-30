'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { TIME_ZONE_COOKIE } from '@/lib/calendarDay';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function readZoneCookie(): string | undefined {
  return document.cookie
    .split('; ')
    .find((pair) => pair.startsWith(`${TIME_ZONE_COOKIE}=`))
    ?.slice(TIME_ZONE_COOKIE.length + 1);
}

/**
 * Records the browser's IANA time zone in a cookie so server-rendered pages can work out
 * the user's calendar day (`getUserToday`, #1072). When the cookie was missing or out of
 * date, the page just rendered used the wrong day, so it refreshes once to re-render with
 * the right one. Renders nothing.
 */
export default function TimeZoneCookie() {
  const router = useRouter();
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || readZoneCookie() === zone) return;
    document.cookie = `${TIME_ZONE_COOKIE}=${zone}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    // Only when the write stuck: with cookies blocked a refresh would change nothing.
    if (readZoneCookie() === zone) router.refresh();
  }, [router]);
  return null;
}
