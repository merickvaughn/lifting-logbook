import { buildEffectiveSlotMap } from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';

/**
 * Builds the per-request slot map used everywhere a CSV `lift` value is
 * validated: DEFAULT_SLOT_MAP plus the requesting user's own custom lifts
 * (issue #911). Every lift-name validation call site (ImportController's
 * preview and commit paths, and the legacy LiftRecordsController import
 * endpoint) must go through this — never a bare DEFAULT_SLOT_MAP — or a
 * user's custom lifts silently stop being recognized. Centralized here
 * (rather than hand-repeated `repos.customLift.list()` +
 * `buildEffectiveSlotMap(...)` at each call site) so a future fourth call
 * site can't accidentally skip the custom-lift merge and still type-check.
 */
export async function effectiveSlotMapFor(repos: RepositoryBundle): Promise<Record<string, string>> {
  const customLifts = await repos.customLift.list();
  return buildEffectiveSlotMap(customLifts);
}
