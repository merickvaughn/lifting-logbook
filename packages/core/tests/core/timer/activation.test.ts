import { readFileSync } from 'fs';
import { resolve } from 'path';
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

/**
 * Minimal RFC-4180-ish field splitter.
 *
 * The program-spec fixtures quote their `Warm-Up %` column, which contains
 * commas — so a naive `split(',')` misaligns every later column and reads the
 * *wrong field* as the activation. That misread is not hypothetical: it makes
 * `Week Type` values look like activation values, which is exactly how a
 * plausible-but-wrong value gets added to the denylist.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch ?? '';
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch ?? '';
  }
  out.push(field);
  return out;
}

/**
 * Every distinct `activation` value in the repo's program-spec import fixtures.
 *
 * This is the corpus that matters most and the one the first cut of this
 * predicate missed. Per ADR-035 Amendment 2 the *import* path is one of only two
 * ways a lifter can name an activation today, so an exported-sheet fixture is a
 * closer model of real user data than the built-in presets are — and unlike the
 * presets it is two-sided, carrying both a "no activation" marker (`N/A`) and
 * genuine movement names (`Band Flye`, `S. Pulldown`, …) in the same column.
 */
function fixtureActivationValues(): string[] {
  const values = new Set<string>();
  const dir = resolve(__dirname, '../../fixtures');
  for (const name of [
    'rpt_program_spec.csv',
    'rpt_program_spec_deload_week.csv',
    'rpt_program_spec_test_week.csv',
  ]) {
    const lines = readFileSync(resolve(dir, name), 'utf8').split(/\r?\n/).filter(Boolean);
    const header = splitCsvLine(lines[0] ?? '');
    const idx = header.findIndex((h) => h.trim().toLowerCase() === 'activation');
    if (idx < 0) throw new Error(`${name} has no Activation column`);
    for (const line of lines.slice(1)) values.add(splitCsvLine(line)[idx] ?? '');
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

  // --- The import fixtures: the two-sided corpus, both directions -----------

  it('extracts a non-empty, two-sided corpus from the import fixtures', () => {
    // Same vacuous-pass guard as above, and a stronger one: this corpus is only
    // a calibration reference if it actually contains BOTH classes. A fixture
    // reshaped to hold only names, or only markers, would still iterate — and
    // the two assertions below would each pass over an empty half.
    const values = fixtureActivationValues();
    expect(values.length).toBeGreaterThan(0);

    const markers = values.filter((v) => activationExercise(v) === undefined);
    const names = values.filter((v) => activationExercise(v) !== undefined);
    expect(markers.length).toBeGreaterThan(0);
    expect(names.length).toBeGreaterThan(0);
  });

  it('reads the "no activation" marker a real exported sheet uses', () => {
    // `N/A` is what `rpt_program_spec.csv` puts in the column for a lift with no
    // drill. The first cut of this predicate calibrated against `PRESET_BASE_SPECS`
    // alone and shipped `Activation · N/A` to the dial for every such lift.
    expect(activationExercise('N/A')).toBeUndefined();
    expect(activationExercise('n/a')).toBeUndefined();
    expect(fixtureActivationValues()).toContain('N/A');
  });

  it('keeps every genuine movement name the import fixtures carry', () => {
    // Abbreviations and dots are ordinary in sheet data — `S. Pulldown` and
    // `OHT Extension` must survive a predicate aimed at `N/A`.
    for (const name of ['Band Flye', 'S. Pulldown', 'KB Swing', 'OHT Extension', 'Lat Raise']) {
      expect(fixtureActivationValues()).toContain(name);
      expect(activationExercise(name)).toBe(name);
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
