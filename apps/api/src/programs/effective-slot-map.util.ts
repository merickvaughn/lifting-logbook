import { buildEffectiveSlotMap } from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';

/**
 * Builds the per-request slot map used everywhere a lift-records CSV `lift`
 * value is validated: DEFAULT_SLOT_MAP plus the requesting user's own custom
 * lifts (issue #911). All three lift-records call sites (ImportController's
 * previewLiftRecords and commit paths, and the legacy
 * LiftRecordsController.importLiftRecords endpoint) must go through this —
 * never a bare DEFAULT_SLOT_MAP — or a user's custom lifts silently stop
 * being recognized there. Centralized here (rather than hand-repeated
 * `repos.customLift.list()` + `buildEffectiveSlotMap(...)` at each call site)
 * purely as a convention to reduce duplication — this is NOT
 * compile-time-enforced (`DEFAULT_SLOT_MAP` is still a plain,
 * directly-importable `Record<string, string>`, so a call site that bypasses
 * this helper and passes it directly still type-checks fine; #911 review,
 * second pass corrected an earlier overclaim here).
 *
 * Deliberately NOT wired into validateTrainingMaxImport/
 * validateStrengthGoalImport, which still resolve lift names against a bare
 * DEFAULT_SLOT_MAP — so the same CSV lift name can resolve to a custom-lift
 * id when imported as lift history but pass through as raw display text when
 * imported as a training max or strength goal. Out of scope for #911 (which
 * is specifically about the lift-records Wizard flow this helper's three
 * call sites serve); extending custom-lift awareness to those two validators
 * is tracked separately as issue #914 (#911 review, third pass).
 *
 * Fetches full CustomLift entities (movementProfile JSON, classification,
 * timestamps) purely to build a name/id lookup map, inside the per-request
 * RLS interactive transaction on the hottest import path (preview AND
 * commit). Accepted as-is rather than adding a narrower `{id, name}`-only
 * repository read: that would mean a port-interface change touching
 * ICustomLiftRepository, the Prisma adapter, and the in-memory test adapter
 * for a marginal gain against a realistic per-user custom-lift count (#911
 * review, third pass) — revisit if custom-lift lists grow large enough for
 * this to show up in practice.
 */
export async function effectiveSlotMapFor(repos: RepositoryBundle): Promise<Record<string, string>> {
  const customLifts = await repos.customLift.list();
  return buildEffectiveSlotMap(customLifts);
}
