import { BUILT_IN_KNOWN_PROGRAMS, PRESET_BASE_SPECS, PROGRAM_LENGTHS } from '@lifting-logbook/core';
import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import { PROGRAM_DEFAULTS } from './macrocycle-generation.service';

/**
 * The reserved program id of a non-cycle workout (proposal 2026-11-06, decision 23, #1184) can't
 * name a real program: no catalog slug in any registry takes it, and a custom program's id is a
 * UUID. Next to the registry sync guard, so a new registry is checked here too.
 */
describe('the reserved non-cycle program id (#1184)', () => {
  const registries: Array<[string, readonly string[]]> = [
    ['PROGRAM_DEFAULTS', Object.keys(PROGRAM_DEFAULTS)],
    ['PRESET_BASE_SPECS', Object.keys(PRESET_BASE_SPECS)],
    ['PROGRAM_LENGTHS', Object.keys(PROGRAM_LENGTHS)],
    ['BUILT_IN_KNOWN_PROGRAMS', BUILT_IN_KNOWN_PROGRAMS.map((program) => program.id)],
  ];

  it.each(registries)('is no slug in %s', (_name, slugs) => {
    // A non-empty registry, so the check can't pass vacuously.
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs.map((slug) => slug.toLowerCase())).not.toContain(NON_CYCLE_PROGRAM);
  });
});
