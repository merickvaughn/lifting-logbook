import { WeekType } from "@lifting-logbook/types";
import { LiftingProgramSpec } from "../models";

/**
 * Returns the next Monday after the given date, at least 7 days later, or the most recent occurrence of a target weekday.
 * @param prevDate Date to start from
 * @param targetWeekday Optional target weekday (0=Sunday, 1=Monday, ... 6=Saturday)
 * @returns Date object for the next Monday (at least 7 days after prevDate), or most recent target weekday if specified
 */
export function getNextDate(
  prevDate: Date,
  targetWeekday: number = prevDate.getDay(),
  today: Date | null = null,
): Date {
  const prevDay = prevDate.getDay();
  const weekday = typeof targetWeekday === "number" ? targetWeekday : prevDay;
  const now = today ? new Date(today) : new Date();
  // 1. Use today if it matches the target weekday and is at least 7 days after prevDate
  if (
    now.getDay() === weekday &&
    now.getTime() - prevDate.getTime() >= 7 * 24 * 60 * 60 * 1000
  ) {
    return now;
  }
  // 2. Use the most recent occurrence of the target weekday if at least 7 days after prevDate
  const offset = (now.getDay() - weekday + 7) % 7;
  const mostRecent = new Date(now);
  mostRecent.setDate(now.getDate() - offset);
  if (mostRecent.getTime() - prevDate.getTime() >= 7 * 24 * 60 * 60 * 1000) {
    return mostRecent;
  }
  // 3. Otherwise, find the next valid occurrence at least 7 days after prevDate
  const cycleDate = new Date(prevDate);
  // Find the next occurrence of the target weekday after prevDate
  const daysToNext = (weekday - prevDay + 7) % 7 || 7;
  cycleDate.setDate(prevDate.getDate() + daysToNext);
  while (cycleDate.getTime() - prevDate.getTime() < 7 * 24 * 60 * 60 * 1000) {
    cycleDate.setDate(cycleDate.getDate() + 7);
  }
  return cycleDate;
}
// Add days to a date in UTC
export function addDaysUTC(date: Date, days: number): Date {
  const utcDate = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return utcDate;
}

// Adds days using local time (keeps date in local timezone)
export function addDaysLocal(date: Date, days: number): Date {
  const localDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  localDate.setDate(localDate.getDate() + days);
  return localDate;
}
// Utility for consistent UTC date formatting
export function formatDateYYYYMMDD(date: string | Date): string {
  if (typeof date === "string") {
    // Accept MM/DD/YYYY or YYYY-MM-DD
    const parts = date.includes("-") ? date.split("-") : date.split("/");
    let yyyy, mm, dd;
    if (parts.length === 3) {
      if (date.includes("-")) {
        yyyy = Number(parts[0]);
        mm = Number(parts[1]);
        dd = Number(parts[2]);
      } else {
        mm = Number(parts[0]);
        dd = Number(parts[1]);
        yyyy = Number(parts[2]);
      }
      const d = new Date(Date.UTC(yyyy, mm - 1, dd));
      return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    }
  }
  // If already a Date object
  if (date instanceof Date) {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  }
  return String(date);
}

/**
 * Inverse of {@link formatDateYYYYMMDD}'s `Date` output: parses a compact
 * `YYYYMMDD` string (no separators) into a UTC-midnight `Date`. Returns
 * `null` for anything that isn't exactly 8 digits, so callers splitting a
 * delimited key/id apart can tell "this segment is the date" from "this
 * isn't" (see `liftRecordNaturalKey.ts`).
 */
export function parseYYYYMMDD(s: string): Date | null {
  if (!/^\d{8}$/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day));
}

// Truncates a Date to UTC midnight of its own calendar day.
export function toUTCMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

// Returns the WeekType for the week containing `today` within a cycle.
// Week 1 = days 0–6 from cycle start; clamped to max week in spec.
export function weekTypeForDate(
  cycleStartDate: Date,
  programSpec: LiftingProgramSpec[],
  today: Date = new Date(),
): WeekType {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const elapsed = Math.max(0, today.getTime() - cycleStartDate.getTime());
  const rawWeekNum = Math.floor(elapsed / msPerWeek) + 1;
  const maxWeek = programSpec.reduce((m, ps) => Math.max(m, ps.week), 1);
  const weekNum = Math.min(rawWeekNum, maxWeek);
  return programSpec.find((ps) => ps.week === weekNum)?.weekType ?? 'training';
}
