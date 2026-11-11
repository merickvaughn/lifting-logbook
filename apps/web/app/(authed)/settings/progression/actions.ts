'use server';

import { revalidatePath } from 'next/cache';
import { updateUserSettings } from '@/lib/api';
import type { DefaultProgressionSetting, UserSettingsResponse } from '@lifting-logbook/types';

// Server-side boundary: lib/api.ts is 'server-only', so a client component cannot import
// it directly. Mirrors settings/weight-rounding/actions.ts. `null` clears the default, so
// each lift's catalog default applies again (#1210).
export async function saveDefaultProgression(
  defaultProgression: DefaultProgressionSetting | null,
): Promise<UserSettingsResponse> {
  const result = await updateUserSettings({ defaultProgression });
  revalidatePath('/settings/progression');
  return result;
}
