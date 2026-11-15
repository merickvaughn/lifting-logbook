import type { CustomLiftResponse, LiftMetadataResponse } from '@lifting-logbook/types';
import { fetchAllLiftMetadata, fetchCustomLifts } from '@/lib/api';

/**
 * What weekly set counts need besides the sets themselves (#1013): the lifter's muscle
 * overrides and custom lifts. Serializable on purpose: `buildMuscleTargetResolver` and
 * `movementPatternsFor` return or need closures, which can't cross from a server component to
 * a client one, so build them from these where they are used.
 */
export interface VolumeResolverInputs {
  overrides: LiftMetadataResponse[];
  customLifts: CustomLiftResponse[];
}

/**
 * Loads the inputs for counting weekly sets. Counts are a summary, not the page, so neither
 * fetch failing is fatal: overrides fall back to none, which counts every lift by its built-in
 * defaults, and custom lifts fall back to none, which leaves a custom lift's movement patterns,
 * and any lift stored by its uuid, uncounted.
 * `caller` names the page in the log line.
 */
export async function loadVolumeResolvers(caller: string): Promise<VolumeResolverInputs> {
  const [overrides, customLifts] = await Promise.all([
    // fallback-covered-by: apps/web/lib/__tests__/volumeResolvers.test.ts
    fetchAllLiftMetadata().catch((err: unknown): LiftMetadataResponse[] => {
      console.error(`[${caller}] lift metadata fetch failed; counting sets by built-in muscle defaults`, err);
      return [];
    }),
    // fallback-covered-by: apps/web/lib/__tests__/volumeResolvers.test.ts
    fetchCustomLifts().catch((err: unknown): CustomLiftResponse[] => {
      console.error(`[${caller}] custom lifts fetch failed; leaving custom lifts uncounted`, err);
      return [];
    }),
  ]);
  return { overrides, customLifts };
}
