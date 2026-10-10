import { PRESET_BASE_SPECS } from '@lifting-logbook/core';
import { PROGRAMS } from '../programs';

/**
 * Forward-looking guard for the issue #739 class of bug. Every program the
 * onboarding catalog marks `available: true` must resolve to a non-empty
 * built-in spec (`PRESET_BASE_SPECS[id]`), otherwise an onboarded user of that
 * program gets an empty macrocycle view. This catches the *other* way this gap can
 * open: flipping a catalog program to `available: true` without adding its
 * preset (the seeding side is guarded by the API repository tests).
 *
 * Catalog programs left `available: false` are intentional future work and are
 * deliberately not asserted here.
 */
describe('onboarding catalog ↔ preset spec invariant (issue #739)', () => {
  const availablePrograms = PROGRAMS.filter((p) => p.available);

  it('has at least one available program', () => {
    // Guards against the filter silently matching nothing, which would make the
    // per-program assertion below vacuously pass.
    expect(availablePrograms.length).toBeGreaterThan(0);
  });

  it.each(availablePrograms.map((p) => p.id))(
    'available program "%s" has a non-empty PRESET_BASE_SPECS entry',
    (id) => {
      const spec = PRESET_BASE_SPECS[id] ?? [];
      expect(spec.length).toBeGreaterThan(0);
    },
  );
});
