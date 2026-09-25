import { DEFAULT_SLOT_MAP, LIFT_CATALOG, liftClassificationFor } from '@src/core';

describe('liftClassificationFor', () => {
  it('classifies a built-in lift by its canonical name', () => {
    expect(liftClassificationFor('Bench Press')).toBe('compound');
    expect(liftClassificationFor('Calf Raise')).toBe('accessory');
  });

  it('classifies a built-in lift through a slot-map alias', () => {
    // "Squat" and "Cable Curls" are program-spec slot names, not catalog names —
    // the catalog spells them "Back Squat" and "Cable Curl". A lookup seeded only
    // from `LIFT_CATALOG.name` would miss both, and they are exactly the names a
    // *built-in* program's spec refers to its lifts by.
    expect(LIFT_CATALOG.some((lift) => lift.name === 'Squat')).toBe(false);
    expect(liftClassificationFor('Squat')).toBe('compound');

    expect(LIFT_CATALOG.some((lift) => lift.name === 'Cable Curls')).toBe(false);
    expect(liftClassificationFor('Cable Curls')).toBe('accessory');
  });

  it('classifies every slot-map alias', () => {
    for (const alias of Object.keys(DEFAULT_SLOT_MAP)) {
      expect(liftClassificationFor(alias)).toBeDefined();
    }
  });

  // This is the assertion the slot-map loop above cannot make. That loop iterates
  // the very map the lookup is seeded from, so it can only fail if a slot-map
  // *value* names no catalog id — it says nothing about whether the vocabulary
  // that actually reaches a workout is covered. A custom program's spec `lift`
  // values come from ProgramEditor's picker, which is built as
  // `LIFT_CATALOG.map((l) => l.name)`, so catalog display names reach here too —
  // and when this test was written only 8 of the then-23 catalog names were
  // slot-map keys. Seeded from DEFAULT_SLOT_MAP alone, 15 of those 23 names
  // returned undefined, 8 of them accessories (Cable Curl, Lateral
  // Raise, Face Pull, Lat Pulldown, Dumbbell Row, Goblet Squat, Hip Thrust,
  // Kettlebell Swing) — the feature silently not firing on the lifts it exists
  // for, with the panel reporting "Follows Standard".
  it('classifies every catalog lift by its own name and id', () => {
    for (const lift of LIFT_CATALOG) {
      expect(liftClassificationFor(lift.name)).toBe(lift.classification);
      expect(liftClassificationFor(lift.id)).toBe(lift.classification);
    }
  });

  it('classifies the catalog names whose slot-map alias differs by a character', () => {
    // The near misses that made the gap above so easy to miss by inspection.
    expect(liftClassificationFor('Cable Curls')).toBe('accessory'); // slot name
    expect(liftClassificationFor('Cable Curl')).toBe('accessory'); // catalog name
    expect(liftClassificationFor('Face Pulls')).toBe('accessory');
    expect(liftClassificationFor('Face Pull')).toBe('accessory');
    expect(liftClassificationFor('Cable Lat Raise')).toBe('accessory');
    expect(liftClassificationFor('Lateral Raise')).toBe('accessory');
  });

  it('classifies the Leangains/RPT preset names that are neither catalog nor slot names', () => {
    // These resolve through per-entry catalog aliases (or, for Cable Row and Leg Curl,
    // catalog entries added for them). Before, all six returned undefined, so the rest
    // timer never applied accessory durations to Leangains' accessories.
    expect(liftClassificationFor('Weighted Pull-ups')).toBe('compound');
    expect(liftClassificationFor('Incline DB Press')).toBe('accessory');
    expect(liftClassificationFor('Cable Row')).toBe('accessory');
    expect(liftClassificationFor('Leg Curl')).toBe('accessory');
    expect(liftClassificationFor('Calf Raises')).toBe('accessory');
    expect(liftClassificationFor('Lateral Raises')).toBe('accessory');
  });

  it('classifies a custom lift from the list it is given', () => {
    expect(
      liftClassificationFor('Sissy Squat', [
        { name: 'Sissy Squat', classification: 'accessory' },
      ]),
    ).toBe('accessory');
  });

  it('lets the built-in win a collision on a reserved slot name', () => {
    // Mirrors buildEffectiveSlotMap: DEFAULT_SLOT_MAP's keys are shared
    // vocabulary every program template relies on, so one user's custom lift
    // must never redirect what "Squat" means.
    expect(
      liftClassificationFor('Squat', [{ name: 'Squat', classification: 'accessory' }]),
    ).toBe('compound');
  });

  it.each([
    ['Cable Row', 'compound'],
    ['Leg Curl', 'compound'],
    ['Weighted Pull-ups', 'accessory'],
    ['Calf Raises', 'compound'],
    ['Face Pull', 'compound'],
  ] as const)('lets a custom lift named %p keep the classification its user recorded', (name, classification) => {
    // Not reserved: the custom-lift guard allows these names (a Leangains importer had to
    // create "Cable Row" and "Leg Curl" as custom lifts), so the user's record wins.
    expect(liftClassificationFor(name, [{ name, classification }])).toBe(classification);
  });

  it('finds a custom lift by its uuid, which import can store as the lift name', () => {
    expect(
      liftClassificationFor('uuid-sissy', [
        { id: 'uuid-sissy', name: 'Sissy Squat', classification: 'accessory' },
      ]),
    ).toBe('accessory');
  });

  it('returns undefined for a lift it has never heard of', () => {
    expect(liftClassificationFor('Zercher Good Morning')).toBeUndefined();
    expect(liftClassificationFor('')).toBeUndefined();
  });

  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'returns undefined for the inherited Object.prototype member %p',
    (name) => {
      // A behavior spec, not a proof that the implementation is prototype-safe:
      // an indexed `DEFAULT_SLOT_MAP[name]` lookup returns these same undefineds
      // by accident (the inherited value is a *function*, which then matches no
      // catalog id), so this assertion cannot tell the two implementations
      // apart. What actually rules the hazard out is that the lookup is a Map
      // built from Object.entries — see BUILT_IN_LIFTS in builtInLift.ts. Kept because
      // the outcome is worth pinning either way.
      expect(liftClassificationFor(name)).toBeUndefined();
    },
  );

  it('still finds a custom lift whose name is an Object.prototype member', () => {
    // The prototype guard must reject the *built-in* lookup without also
    // discarding a genuine custom lift that happens to be named this.
    expect(
      liftClassificationFor('toString', [{ name: 'toString', classification: 'accessory' }]),
    ).toBe('accessory');
  });
});
