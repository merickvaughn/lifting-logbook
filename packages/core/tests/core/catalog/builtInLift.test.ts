import { DEFAULT_SLOT_MAP, LIFT_CATALOG, PRESET_BASE_SPECS, builtInLiftFor } from '@src/core';

describe('builtInLiftFor', () => {
  it('resolves every catalog lift by its display name and its id', () => {
    for (const lift of LIFT_CATALOG) {
      expect(builtInLiftFor(lift.name)).toBe(lift);
      expect(builtInLiftFor(lift.id)).toBe(lift);
    }
  });

  it('resolves every DEFAULT_SLOT_MAP slot name to the catalog entry it maps to', () => {
    for (const [alias, catalogId] of Object.entries(DEFAULT_SLOT_MAP)) {
      expect(builtInLiftFor(alias)?.id).toBe(catalogId);
    }
  });

  it('resolves every per-entry alias to the entry that declares it', () => {
    // An alias that collided with another lift's name, id or slot name would silently
    // resolve to that other lift — this is the assertion that rules it out.
    const withAliases = LIFT_CATALOG.filter((lift) => (lift.aliases ?? []).length > 0);
    expect(withAliases.length).toBeGreaterThan(0);
    for (const lift of withAliases) {
      for (const alias of lift.aliases ?? []) {
        expect(builtInLiftFor(alias)).toBe(lift);
      }
    }
  });

  it('keeps per-entry aliases out of DEFAULT_SLOT_MAP', () => {
    // DEFAULT_SLOT_MAP also drives the logger's bodyweight detection and import
    // validation; aliasing a preset name there is a separate decision (issue #1015).
    const slotNames = new Set(Object.keys(DEFAULT_SLOT_MAP));
    for (const lift of LIFT_CATALOG) {
      for (const alias of lift.aliases ?? []) {
        expect(slotNames.has(alias)).toBe(false);
      }
    }
  });

  // The guarantee the muscle and pattern counts rest on: a built-in program's lift that
  // resolves to nothing would drop out of every count as "not counted".
  it('resolves every lift name the built-in presets use, and each has default muscles', () => {
    const presetLifts = [
      ...new Set(Object.values(PRESET_BASE_SPECS).flatMap((spec) => spec.map((row) => row.lift))),
    ];
    // Guards against a vacuous pass: an empty extraction would satisfy the loop below.
    expect(presetLifts.length).toBeGreaterThan(0);
    for (const name of presetLifts) {
      const lift = builtInLiftFor(name);
      expect({ name, resolved: lift !== undefined }).toEqual({ name, resolved: true });
      expect(lift?.muscles.primary.length).toBeGreaterThan(0);
    }
  });

  it('resolves the six Leangains/RPT names that previously resolved to nothing', () => {
    expect(builtInLiftFor('Weighted Pull-ups')?.id).toBe('pull-up');
    expect(builtInLiftFor('Incline DB Press')?.id).toBe('incline-db-press');
    expect(builtInLiftFor('Cable Row')?.id).toBe('cable-row');
    expect(builtInLiftFor('Leg Curl')?.id).toBe('leg-curl');
    expect(builtInLiftFor('Calf Raises')?.id).toBe('calf-raise');
    expect(builtInLiftFor('Lateral Raises')?.id).toBe('lateral-raise');
  });

  it('matches exactly — case and whitespace variants miss', () => {
    expect(builtInLiftFor('squat')).toBeUndefined();
    expect(builtInLiftFor(' Squat ')).toBeUndefined();
    expect(builtInLiftFor('calf raises')).toBeUndefined();
  });

  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', ''])(
    'returns undefined for %p',
    (name) => {
      expect(builtInLiftFor(name)).toBeUndefined();
    },
  );
});
