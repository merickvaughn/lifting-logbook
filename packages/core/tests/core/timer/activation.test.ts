import { PRESET_BASE_SPECS, activationExercise } from '@src/core';

/**
 * Calibration for the one predicate in this feature that classifies inputs the
 * code does not enumerate.
 *
 * `activationExercise` decides whether the program spec's `activation` column
 * holds a movement name or a legacy classification value. Getting that wrong in
 * the permissive direction puts "Activation · compound" on the dial for every
 * built-in-program user; getting it wrong in the strict direction silently drops
 * a real activation. So both references are exercised here, and the known-good
 * corpus is read **live** out of `PRESET_BASE_SPECS` rather than transcribed —
 * a transcribed list would keep passing after the presets changed underneath it.
 */

/** Every distinct `activation` value the shipped presets actually carry. */
function shippedPresetActivationValues(): string[] {
  const values = new Set<string>();
  for (const specs of Object.values(PRESET_BASE_SPECS)) {
    for (const spec of specs) values.add(spec.activation);
  }
  return [...values];
}

describe('activationExercise', () => {
  // --- Known-good: must yield NO activation ---------------------------------

  it('extracts a non-empty corpus from the shipped presets', () => {
    // Guards the assertion below against a vacuous pass: if `PRESET_BASE_SPECS`
    // is ever reshaped so this extraction yields nothing, the loop underneath
    // would iterate zero times and "pass" while checking nothing at all.
    const values = shippedPresetActivationValues();
    expect(values.length).toBeGreaterThan(0);
    // The two legacy classification values the presets are known to carry. A new
    // value appearing here is a signal to re-run this calibration, not to widen
    // the assertion silently.
    expect(values.sort()).toEqual(['compound', 'isolation']);
  });

  it('treats every value the shipped presets carry as "no activation"', () => {
    for (const value of shippedPresetActivationValues()) {
      expect(activationExercise(value)).toBeUndefined();
    }
  });

  it.each([
    ['', 'the column absent on import'],
    ['   ', 'a whitespace-only cell'],
    ['compound', "the program editor's default row"],
    ['isolation', 'PRESET_BASE_SPECS (Leg Curl, Calf Raises)'],
    ['none', 'the e2e mock API and the create-custom-program fixture'],
  ])('reads %p as no activation (%s)', (value) => {
    expect(activationExercise(value)).toBeUndefined();
  });

  it('compares case-insensitively, so a spreadsheet "None" is still no activation', () => {
    expect(activationExercise('None')).toBeUndefined();
    expect(activationExercise('Compound')).toBeUndefined();
    expect(activationExercise('  ISOLATION  ')).toBeUndefined();
  });

  it('reads a missing column as no activation rather than throwing', () => {
    expect(activationExercise(undefined)).toBeUndefined();
    expect(activationExercise(null)).toBeUndefined();
  });

  // --- Known-bad: must yield an activation ---------------------------------

  it.each([
    ['Hip Airplane', 'the design mockup’s own sample workout'],
    ['leg press', "the design doc's own example value"],
    ['Band Pull-Apart', 'an ordinary movement name'],
  ])('reads %p as an activation movement (%s)', (value) => {
    expect(activationExercise(value)).toBe(value);
  });

  it('trims a padded name rather than rejecting it', () => {
    expect(activationExercise('  Band Pull-Apart  ')).toBe('Band Pull-Apart');
  });

  it('keeps a name that merely contains a legacy word', () => {
    // The comparison is whole-value, not substring: "Compound Row" is a real
    // movement and must survive.
    expect(activationExercise('Compound Row')).toBe('Compound Row');
    expect(activationExercise('Isolation Hold')).toBe('Isolation Hold');
  });
});
