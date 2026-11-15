import type { CustomLiftResponse, LiftMetadataResponse } from '@lifting-logbook/types';
import { fetchAllLiftMetadata, fetchCustomLifts } from '@/lib/api';
import { withTimeout } from '@/lib/with-timeout';

/**
 * How long a page waits for each input before counting without it. A latency budget for an
 * optional summary, sized like the workout pages' `CUSTOM_LIFTS_TIMEOUT_MS`: the api-client's
 * own 30 s abort would hold the whole page that long.
 */
export const VOLUME_INPUTS_TIMEOUT_MS = 1500;

/**
 * What weekly set counts need besides the sets themselves (#1013): the lifter's muscle
 * overrides and custom lifts. Serializable on purpose: `buildMuscleTargetResolver` and
 * `movementPatternsFor` return or need closures, which can't cross from a server component to
 * a client one, so build them from these where they are used.
 */
export interface VolumeResolverInputs {
  overrides: LiftMetadataResponse[];
  customLifts: CustomLiftResponse[];
  /** The overrides didn't load, so every lift is counted by its built-in muscles. */
  overridesFailed: boolean;
  /** The custom lifts didn't load, so they, and any lift stored by its uuid, aren't counted. */
  customLiftsFailed: boolean;
}

/**
 * Loads the inputs for counting weekly sets. Counts are a summary, not the page, so neither
 * fetch failing or running slow is fatal: it falls back to none, and its flag says so, so the
 * page can say what the counts are missing. `caller` names the page in the log lines.
 */
export async function loadVolumeResolvers(caller: string): Promise<VolumeResolverInputs> {
  const [overrides, customLifts] = await Promise.all([
    withTimeout<LiftMetadataResponse[] | null>(
      // fallback-covered-by: apps/web/lib/__tests__/volumeResolvers.test.ts
      fetchAllLiftMetadata().catch((err: unknown) => {
        console.error(`[${caller}] lift metadata fetch failed; counting sets by built-in muscle defaults`, err);
        return null;
      }),
      VOLUME_INPUTS_TIMEOUT_MS,
      null,
      () => console.warn(`[${caller}] lift metadata fetch slow; counting sets by built-in muscle defaults`),
    ),
    withTimeout<CustomLiftResponse[] | null>(
      // fallback-covered-by: apps/web/lib/__tests__/volumeResolvers.test.ts
      fetchCustomLifts().catch((err: unknown) => {
        console.error(`[${caller}] custom lifts fetch failed; leaving custom lifts uncounted`, err);
        return null;
      }),
      VOLUME_INPUTS_TIMEOUT_MS,
      null,
      () => console.warn(`[${caller}] custom lifts fetch slow; leaving custom lifts uncounted`),
    ),
  ]);
  return {
    // fallback-covered-by: apps/web/lib/__tests__/volumeResolvers.test.ts
    overrides: overrides ?? [],
    // fallback-covered-by: apps/web/lib/__tests__/volumeResolvers.test.ts
    customLifts: customLifts ?? [],
    overridesFailed: overrides === null,
    customLiftsFailed: customLifts === null,
  };
}
