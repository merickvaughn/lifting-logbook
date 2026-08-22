import { buildEffectiveSlotMap } from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';

/**
 * Builds the per-request slot map used everywhere a lift-records CSV `lift`
 * value is validated: DEFAULT_SLOT_MAP plus the requesting user's own custom
 * lifts (issue #911). All three lift-records call sites (ImportController's
 * previewLiftRecords and commit paths, and the legacy
 * LiftRecordsController.importLiftRecords endpoint) must go through this —
 * never a bare DEFAULT_SLOT_MAP — or a user's custom lifts silently stop
 * being recognized there. Not compile-time-enforced: `DEFAULT_SLOT_MAP` is
 * still a plain, directly-importable `Record<string, string>`, so a call
 * site that bypasses this helper and passes it directly still type-checks.
 *
 * Deliberately NOT wired into validateTrainingMaxImport/
 * validateStrengthGoalImport, which still resolve lift names against a bare
 * DEFAULT_SLOT_MAP — so the same CSV lift name can resolve to a custom-lift
 * id when imported as lift history but pass through as raw display text when
 * imported as a training max or strength goal (including via a splitDest
 * commit's automatic 1RM partition, with no separate destination choice by
 * the user). Tracked as issue #914, which should resolve both as one fix.
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
