'use server';

import { revalidatePath } from 'next/cache';
import { ApiClientError } from '@lifting-logbook/api-client';
import { redateCurrentMacrocycle, updateUserSettings } from '@/lib/api';
import type {
  RedateMacrocycleResponse,
  UpdateUserSettingsRequest,
  UserSettingsResponse,
} from '@lifting-logbook/types';

// Server-side boundary: lib/api.ts is 'server-only', so a client component cannot import
// it directly. This action lets ScheduleForm reach the API while keeping auth-token
// acquisition (and any future server-only logic) off the wire.
export async function saveSchedule(
  body: UpdateUserSettingsRequest,
): Promise<UserSettingsResponse> {
  const result = await updateUserSettings(body);
  revalidatePath('/settings/schedule');
  return result;
}

/**
 * Re-dates the program's current macrocycle by the schedule just saved (#1032). `today` is the
 * lifter's local date. Null when the program has no current macrocycle (a 404), so there is
 * nothing to re-date; any other failure throws.
 */
export async function redateMacrocycle(
  program: string,
  today: string,
): Promise<RedateMacrocycleResponse | null> {
  try {
    return await redateCurrentMacrocycle(program, today);
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) return null;
    throw err;
  }
}
