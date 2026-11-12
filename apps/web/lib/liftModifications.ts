import type { LiftModificationRef } from '@lifting-logbook/types';

/**
 * ` · Wide grip, Paused` for a logged set with modifications, `''` for one without, so a set
 * reads `65 lbs × 10 · Wide grip` (#1152).
 */
export function modificationSuffix(record: { modifications?: readonly LiftModificationRef[] } | undefined): string {
  const names = (record?.modifications ?? []).map((m) => m.name);
  return names.length > 0 ? ` · ${names.join(', ')}` : '';
}
