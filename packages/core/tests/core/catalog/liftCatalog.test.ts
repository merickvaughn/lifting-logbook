import { DEFAULT_SLOT_MAP, LIFT_CATALOG, resolveLift, buildEffectiveSlotMap } from "@src/core";
import type { Lift, CustomLift } from "@lifting-logbook/types";

describe("LIFT_CATALOG", () => {
  it("contains at least 20 lifts", () => {
    expect(LIFT_CATALOG.length).toBeGreaterThanOrEqual(20);
  });

  it("all lifts have a non-empty id, name, and valid classification", () => {
    for (const lift of LIFT_CATALOG) {
      expect(lift.id).toBeTruthy();
      expect(lift.name).toBeTruthy();
      expect(['compound', 'accessory']).toContain(lift.classification);
    }
  });

  it("every lift has a valid movementProfile (patterns, jointActions, complexity)", () => {
    const validTags = new Set(['push', 'pull', 'vertical', 'horizontal', 'hinge', 'carry', 'squat']);
    const validJointActions = new Set([
      'flexion', 'extension', 'internal-rotation', 'external-rotation', 'abduction', 'adduction',
    ]);
    const validComplexity = new Set(['simple', 'compound']);
    for (const lift of LIFT_CATALOG) {
      const profile = lift.movementProfile;
      expect(profile).toBeDefined();
      expect(Array.isArray(profile.patterns)).toBe(true);
      expect(Array.isArray(profile.jointActions)).toBe(true);
      for (const tag of profile.patterns) {
        expect(validTags.has(tag)).toBe(true);
      }
      for (const action of profile.jointActions) {
        expect(validJointActions.has(action)).toBe(true);
      }
      expect(validComplexity.has(profile.complexity)).toBe(true);
    }
  });

  it("all lift ids are unique", () => {
    const ids = LIFT_CATALOG.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe("classification and patterns — spot checks", () => {
    it("deadlift is compound with hinge pattern", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'deadlift')!;
      expect(lift.classification).toBe('compound');
      expect(lift.movementProfile.patterns).toContain('hinge');
    });

    it("bench-press is compound with push and horizontal patterns", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'bench-press')!;
      expect(lift.classification).toBe('compound');
      expect(lift.movementProfile.patterns).toContain('push');
      expect(lift.movementProfile.patterns).toContain('horizontal');
    });

    it("overhead-press is compound with push and vertical patterns", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'overhead-press')!;
      expect(lift.classification).toBe('compound');
      expect(lift.movementProfile.patterns).toContain('push');
      expect(lift.movementProfile.patterns).toContain('vertical');
    });

    it("chin-up is compound with pull and vertical patterns", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'chin-up')!;
      expect(lift.classification).toBe('compound');
      expect(lift.movementProfile.patterns).toContain('pull');
      expect(lift.movementProfile.patterns).toContain('vertical');
    });

    it("barbell-row is compound with pull and horizontal patterns", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'barbell-row')!;
      expect(lift.classification).toBe('compound');
      expect(lift.movementProfile.patterns).toContain('pull');
      expect(lift.movementProfile.patterns).toContain('horizontal');
    });

    it("cable-curl is accessory with pull pattern", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'cable-curl')!;
      expect(lift.classification).toBe('accessory');
      expect(lift.movementProfile.patterns).toContain('pull');
    });

    it("farmers-carry is compound with carry pattern", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'farmers-carry')!;
      expect(lift.classification).toBe('compound');
      expect(lift.movementProfile.patterns).toContain('carry');
    });
  });

  describe("jointActions and complexity — spot checks", () => {
    it("face-pull drives external-rotation and is movement-simple", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'face-pull')!;
      expect(lift.movementProfile.jointActions).toContain('external-rotation');
      expect(lift.movementProfile.complexity).toBe('simple');
    });

    it("lateral-raise drives abduction and is movement-simple", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'lateral-raise')!;
      expect(lift.movementProfile.jointActions).toContain('abduction');
      expect(lift.movementProfile.complexity).toBe('simple');
    });

    it("back-squat drives flexion/extension and is movement-compound", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'back-squat')!;
      expect(lift.movementProfile.jointActions).toEqual(expect.arrayContaining(['flexion', 'extension']));
      expect(lift.movementProfile.complexity).toBe('compound');
    });

    it("goblet-squat is movement-compound yet role-accessory (axes are independent)", () => {
      const lift = LIFT_CATALOG.find((l) => l.id === 'goblet-squat')!;
      expect(lift.classification).toBe('accessory');
      expect(lift.movementProfile.complexity).toBe('compound');
    });
  });

  describe("covers major movement patterns", () => {
    it("has at least one squat-pattern lift", () => {
      expect(LIFT_CATALOG.some((l) => l.movementProfile.patterns.includes('squat'))).toBe(true);
    });

    it("has at least one hinge-pattern lift", () => {
      expect(LIFT_CATALOG.some((l) => l.movementProfile.patterns.includes('hinge'))).toBe(true);
    });

    it("has at least one carry-pattern lift", () => {
      expect(LIFT_CATALOG.some((l) => l.movementProfile.patterns.includes('carry'))).toBe(true);
    });

    it("has at least one vertical push lift", () => {
      expect(
        LIFT_CATALOG.some(
          (l) => l.movementProfile.patterns.includes('push') && l.movementProfile.patterns.includes('vertical'),
        ),
      ).toBe(true);
    });

    it("has at least one vertical pull lift", () => {
      expect(
        LIFT_CATALOG.some(
          (l) => l.movementProfile.patterns.includes('pull') && l.movementProfile.patterns.includes('vertical'),
        ),
      ).toBe(true);
    });

    it("has at least one horizontal push lift", () => {
      expect(
        LIFT_CATALOG.some(
          (l) => l.movementProfile.patterns.includes('push') && l.movementProfile.patterns.includes('horizontal'),
        ),
      ).toBe(true);
    });

    it("has at least one horizontal pull lift", () => {
      expect(
        LIFT_CATALOG.some(
          (l) => l.movementProfile.patterns.includes('pull') && l.movementProfile.patterns.includes('horizontal'),
        ),
      ).toBe(true);
    });
  });
});

describe("resolveLift", () => {
  it("resolves a canonical slot name to the correct catalog lift", () => {
    const lift = resolveLift('Deadlift', DEFAULT_SLOT_MAP, LIFT_CATALOG);
    expect(lift.id).toBe('deadlift');
    expect(lift.name).toBe('Deadlift');
  });

  it("resolves an RPT-abbreviated slot name to the correct catalog lift", () => {
    const lift = resolveLift('Bench P.', DEFAULT_SLOT_MAP, LIFT_CATALOG);
    expect(lift.id).toBe('bench-press');
    expect(lift.name).toBe('Bench Press');
  });

  it("resolves abbreviated RPT slot names to the correct catalog ids", () => {
    const cases: [string, string][] = [
      ['Bench P.',    'bench-press'],
      ['BB Row',      'barbell-row'],
      ['C. Lat Raise','lateral-raise'],
      ['OH Press',    'overhead-press'],
      ['OH Press-HV', 'overhead-press'],
      ['CBL Curls',   'cable-curl'],
      ['Dip',         'dip'],
    ];
    for (const [slot, expectedId] of cases) {
      expect(resolveLift(slot, DEFAULT_SLOT_MAP, LIFT_CATALOG).id).toBe(expectedId);
    }
  });

  it("every DEFAULT_SLOT_MAP value is a valid catalog id", () => {
    const catalogIds = new Set(LIFT_CATALOG.map((l) => l.id));
    for (const [slot, liftId] of Object.entries(DEFAULT_SLOT_MAP)) {
      expect(catalogIds.has(liftId)).toBe(true);
    }
  });

  it("resolves all 5/3/1 canonical slot names without error", () => {
    const fiveThreeOneSlots = ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press'];
    for (const slot of fiveThreeOneSlots) {
      expect(() => resolveLift(slot, DEFAULT_SLOT_MAP, LIFT_CATALOG)).not.toThrow();
    }
  });

  it("throws when slot name is not in the slot map", () => {
    expect(() => resolveLift('Unknown Exercise', DEFAULT_SLOT_MAP, LIFT_CATALOG)).toThrow(
      /Unknown exercise slot/,
    );
  });

  it("throws when resolved lift id is not in the catalog", () => {
    const badMap: Record<string, string> = { 'Squat': 'nonexistent-id' };
    expect(() => resolveLift('Squat', badMap, LIFT_CATALOG)).toThrow(
      /not found in catalog/,
    );
  });
});

describe("resolveLift with custom lifts", () => {
  const customSafetyBar: Lift = {
    id: 'custom-safety-bar-squat',
    name: 'Safety Bar Squat',
    classification: 'compound',
    movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    isCustom: true,
  };

  it("resolves a slot-mapped id to a custom lift not present in the catalog", () => {
    const slotMap: Record<string, string> = { 'SSB': 'custom-safety-bar-squat' };
    const lift = resolveLift('SSB', slotMap, LIFT_CATALOG, [customSafetyBar]);
    expect(lift).toBe(customSafetyBar);
    expect(lift.isCustom).toBe(true);
  });

  it("prefers a custom lift over a catalog entry with the same id (user intent wins)", () => {
    const shadow: Lift = {
      id: 'deadlift',
      name: 'My Deadlift',
      classification: 'compound',
      movementProfile: { patterns: ['hinge'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
      isCustom: true,
    };
    const lift = resolveLift('Deadlift', DEFAULT_SLOT_MAP, LIFT_CATALOG, [shadow]);
    expect(lift).toBe(shadow);
    expect(lift.name).toBe('My Deadlift');
  });

  it("falls back to the catalog when no custom lift matches the resolved id", () => {
    const lift = resolveLift('Deadlift', DEFAULT_SLOT_MAP, LIFT_CATALOG, [customSafetyBar]);
    expect(lift.id).toBe('deadlift');
    expect(lift.isCustom).toBeUndefined();
  });

  it("still throws when the resolved id is in neither the custom list nor the catalog", () => {
    const badMap: Record<string, string> = { 'Squat': 'nonexistent-id' };
    expect(() => resolveLift('Squat', badMap, LIFT_CATALOG, [customSafetyBar])).toThrow(
      /not found in catalog/,
    );
  });
});

describe("buildEffectiveSlotMap", () => {
  function makeCustomLift(overrides: Partial<CustomLift> = {}): CustomLift {
    return {
      id: 'custom-1',
      name: 'Wide-Grip CBL Curls',
      classification: 'accessory',
      movementProfile: { patterns: ['pull'], jointActions: ['flexion'], complexity: 'simple' },
      userId: 'user-1',
      isCustom: true,
      createdAt: new Date('2026-01-01'),
      ...overrides,
    };
  }

  it("returns DEFAULT_SLOT_MAP unchanged when there are no custom lifts", () => {
    expect(buildEffectiveSlotMap([])).toEqual(DEFAULT_SLOT_MAP);
  });

  it("merges a custom lift by both its display name and its own id", () => {
    const lift = makeCustomLift();
    const merged = buildEffectiveSlotMap([lift]);
    expect(merged[lift.name]).toBe(lift.id);
    expect(merged[lift.id]).toBe(lift.id);
    // Built-ins are still present, untouched
    expect(merged['Squat']).toBe('back-squat');
  });

  it("lets DEFAULT_SLOT_MAP win when a custom lift's name collides with a built-in key", () => {
    const lift = makeCustomLift({ name: 'Squat', id: 'custom-squat-id' });
    const merged = buildEffectiveSlotMap([lift]);
    // Canonical "Squat" must keep resolving to the shared built-in lift, not this user's custom lift
    expect(merged['Squat']).toBe('back-squat');
    // The custom lift is still reachable directly by its own id
    expect(merged[lift.id]).toBe(lift.id);
  });

  it("merges multiple custom lifts", () => {
    const a = makeCustomLift({ id: 'custom-a', name: 'Custom A' });
    const b = makeCustomLift({ id: 'custom-b', name: 'Custom B' });
    const merged = buildEffectiveSlotMap([a, b]);
    expect(merged['Custom A']).toBe('custom-a');
    expect(merged['Custom B']).toBe('custom-b');
  });
});
