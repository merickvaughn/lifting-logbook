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
 * `buildEffectiveSlotMap(...)` at each call site) purely as a convention to
 * reduce duplication — this is NOT compile-time-enforced (`DEFAULT_SLOT_MAP`
 * is still a plain, directly-importable `Record<string, string>`, so a call
 * site that bypasses this helper and passes it directly still type-checks
 * fine; #911 review, second pass corrected an earlier overclaim here). A
 * fourth validation call site must still be added deliberately.
 */
export async function effectiveSlotMapFor(repos: RepositoryBundle): Promise<Record<string, string>> {
  const customLifts = await repos.customLift.list();
  return buildEffectiveSlotMap(customLifts);
}
