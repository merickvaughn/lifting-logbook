import { BadRequestException } from '@nestjs/common';
import { parseIsoDate } from '@lifting-logbook/core';

/**
 * Validates the `today` query parameter: the user's calendar day as an ISO date. The server
 * cannot know the user's time zone, so every endpoint whose answer depends on the day takes
 * it from the client (the core focus date math runs on UTC midnights).
 */
export function parseToday(value: string | undefined): string {
  return parseIsoDateParam('today', value);
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
