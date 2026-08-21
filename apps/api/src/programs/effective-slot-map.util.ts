import { buildEffectiveSlotMap } from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';

/**
 * Builds the per-request slot map used everywhere a CSV `lift` value is
 * validated against a user's own custom lifts: DEFAULT_SLOT_MAP plus the
 * requesting user's own custom lifts (issue #911). Call sites: all three
 * lift-records paths (ImportController's previewLiftRecords and commit
 * paths, and the legacy LiftRecordsController.importLiftRecords endpoint),
 * plus ImportController's training-maxes and strength-goals preview
 * (parseAndValidate) and commit paths (issue #914). Any of these must go
 * through this — never a bare DEFAULT_SLOT_MAP — or a user's custom lifts
 * silently stop being recognized there. Not compile-time-enforced:
 * `DEFAULT_SLOT_MAP` is still a plain, directly-importable
 * `Record<string, string>`, so a call site that bypasses this helper and
 * passes it directly still type-checks. IMPORT_HANDLERS'
 * `lift-records`/`training-maxes`/`strength-goals` entries additionally
 * guard this at runtime — their `validate` closures throw unconditionally
 * rather than risk ever running against a bare DEFAULT_SLOT_MAP (see
 * import-handlers.ts).
 *
 * Extending training-maxes/strength-goals onto this helper (#914) also
 * resolves a splitDest interaction: a splitDest commit partitions a
 * 1RM-noted lift-records row (already resolved to a custom-lift id via this
 * helper) into a training-max write keyed by that id
 * (splitLiftRecordsByDestination) — a *separate* training-maxes import of
 * the same lift by display name now resolves through this same effective
 * slot map too, so it correctly updates rather than duplicates a training
 * max a splitDest commit already wrote for that lift.
 *
 * Fetches full CustomLift entities purely to build a name/id lookup map,
 * inside the per-request RLS transaction on the hottest import path.
 * Accepted rather than adding a narrower `{id, name}`-only repository read
 * (a port-interface change for a marginal gain against realistic per-user
 * custom-lift counts) — revisit if that assumption stops holding.
 */
export async function effectiveSlotMapFor(repos: RepositoryBundle): Promise<Record<string, string>> {
  const customLifts = await repos.customLift.list();
  return buildEffectiveSlotMap(customLifts);
}
