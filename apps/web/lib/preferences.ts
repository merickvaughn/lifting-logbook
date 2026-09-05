import 'server-only';

import { DEFAULT_WEIGHT_UNIT } from '@lifting-logbook/types';
import type { WeightUnit } from '@lifting-logbook/types';
import { getUserSettings } from './active-program';

/**
 * The user's preferred weight-display unit, falling back to 'lbs' when unset
 * or when the API is unreachable — never throws. Display preference only;
 * every weight stays stored/compared in its original unit at full precision
 * (see docs/standards/training-max-precision.md).
 *
 * Reads through the React-`cache()`-wrapped `getUserSettings` (not a raw
 * `fetchUserSettings`) so a page that also calls `getActiveProgram()` — nearly
 * all of them do — shares a single `/users/me/settings` round-trip per render
 * instead of issuing a duplicate GET.
 */
export async function getPreferredUnit(): Promise<WeightUnit> {
  // fallback-covered-by: apps/web/lib/__tests__/preferences.test.ts
  const settings = await getUserSettings().catch(() => null);
  return settings?.unit ?? DEFAULT_WEIGHT_UNIT;
}
