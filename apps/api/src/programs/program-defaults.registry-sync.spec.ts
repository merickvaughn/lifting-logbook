import { PRESET_BASE_SPECS } from '@lifting-logbook/core';
import { PROGRAM_DEFAULTS } from './macrocycle-generation.service';

/**
 * Forward-looking guard for the registry-drift bug class fixed on the seeding
 * side by issue #739 / PR #742. Built-in programs live in two parallel registries
 * that must be kept in sync by hand:
 *
 *   - PRESET_BASE_SPECS (packages/core/src/presets/index.ts) — the program-spec
 *     rows (leangains, rpt, 5-3-1).
 *   - PROGRAM_DEFAULTS (this directory's macrocycle-generation.service.ts) — the
 *     { macrocycleUnit, programType } metadata initializeFirstMacrocycle needs to bootstrap
 *     macrocycle 1.
 *
 * A preset present in PRESET_BASE_SPECS but missing from PROGRAM_DEFAULTS cannot
 * bootstrap a macrocycle: initializeFirstMacrocycle's `PROGRAM_DEFAULTS[program] ?? ...`
 * fallback only recognizes UUID custom-program ids, so a non-UUID preset id falls
 * through to BadRequestException('Unknown program') for every first-time user of
 * that program.
 *
 * The invariant is intentionally ONE-DIRECTIONAL. PROGRAM_DEFAULTS is a deliberate
 * superset — starting-strength, stronglifts, smolov, … can bootstrap a macrocycle with
 * no seeded spec ("degraded but safe", per the service doc comment and the
 * `programSpec.length > 0` schedule guard) — so asserting the reverse would fail on
 * those intentional spec-less entries. This mirrors the reciprocal guard for the
 * third registry (PROGRAM_LENGTHS) in packages/core/src/presets/programLengths.test.ts.
 */
describe('PRESET_BASE_SPECS ↔ PROGRAM_DEFAULTS registry sync (issue #747)', () => {
  it('has at least one preset (guards against a vacuous it.each pass)', () => {
    expect(Object.keys(PRESET_BASE_SPECS).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PRESET_BASE_SPECS))(
    'preset "%s" has a PROGRAM_DEFAULTS entry to bootstrap its first macrocycle',
    (presetId) => {
      const defaults = PROGRAM_DEFAULTS[presetId];
      // A missing entry sends first-time users of this preset to
      // BadRequestException('Unknown program') in initializeFirstMacrocycle.
      expect(defaults).toBeDefined();
      // A present-but-empty entry degrades the same way: macrocycleUnit and programType
      // are written straight onto the bootstrap MacrocycleDashboard.
      expect(defaults?.macrocycleUnit).toBeTruthy();
      expect(defaults?.programType).toBeTruthy();
    },
  );
});
