import { BadRequestException } from '@nestjs/common';
import { parseIsoDate, toIsoDate } from '@lifting-logbook/core';

const DAY_MS = 86_400_000;

/**
 * Validates the `today` query parameter: the user's calendar day as an ISO date. The server
 * cannot know the user's time zone, so every endpoint whose answer depends on the day takes
 * it from the client (the core focus date math runs on UTC midnights).
 */
export function parseToday(value: string | undefined): string {
  return parseIsoDateParam('today', value);
}

/**
 * `today` for a write that stores it, which also can't be more than a day past the server's UTC
 * date. Every time zone, UTC−12 to UTC+14, is within a day of UTC, so this refuses only a date no
 * lifter has yet: a wrong device clock or a typo, which would otherwise be stored for good.
 */
export function parseWriteToday(value: string | undefined, now: Date = new Date()): string {
  const today = parseToday(value);
  const latest = toIsoDate(new Date(now.getTime() + DAY_MS));
  if (today > latest) {
    throw new BadRequestException(`today (${today}) is more than a day past the server's date; the latest it can be is ${latest}`);
  }
  return today;
}

/** An ISO date (`YYYY-MM-DD`) that exists in its month, or a 400. */
export function parseIsoDateParam(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new BadRequestException(`${name} is required (YYYY-MM-DD)`);
  }
  try {
    parseIsoDate(value);
  } catch {
    throw new BadRequestException(`${name} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}
