/**
 * Reading the program spec's overloaded `activation` column.
 *
 * The column's documented meaning is an *exercise name*: the JSON schema for the
 * program-spec import calls it "Activation exercise name"
 * (`packages/core/tests/fixtures/rpt_program_spec.schema.json`), it maps to the
 * legacy `"Activ. Ex."` sheet column (`LIFT_SPEC_HEADERS` in
 * `../constants/config`), and the design doc's own example is `"leg press"`.
 *
 * But `PRESET_BASE_SPECS` and the program editor's default row store a movement
 * *classification* there instead — `'compound'` / `'isolation'`. Nothing read the
 * column until the rest timer did, so the overload was harmless; read naively it
 * would put "Activation · compound" on the dial for every built-in-program user.
 *
 * Rather than rewrite the preset literals — which `presets/index.test.ts` asserts
 * on, and which are the only classification data the repo has — this narrows the
 * read: a closed set of legacy values means "no activation", everything else is a
 * movement name.
 */

/**
 * Values the `activation` column carries that are NOT an exercise name.
 *
 * Every member traces to a *shipped* literal, not to a test fixture:
 *
 * | Value         | Provenance                                                        |
 * |---------------|-------------------------------------------------------------------|
 * | `''`          | the column absent on import                                        |
 * | `'compound'`  | `PRESET_BASE_SPECS` (leangains / rpt / 5-3-1); the editor's default |
 * | `'isolation'` | `PRESET_BASE_SPECS` (`Leg Curl`, `Calf Raises`)                     |
 * | `'none'`      | the e2e mock API; the create-custom-program DTO fixture             |
 *
 * `'main'`, `'standard'` and `'accessory'` are deliberately absent: they occur
 * only in unrelated API test fixtures, so adding them would be reading the set
 * off the wrong class. A lifter whose imported Activation column literally says
 * "main" gets a phase named "main", and turns it off with a per-lift override of
 * `activation: 0`.
 */
const NON_EXERCISE_VALUES: ReadonlySet<string> = new Set([
  '',
  'compound',
  'isolation',
  'none',
]);

/**
 * The activation movement for a lift, or `undefined` when it has none.
 *
 * Compared case-insensitively and trimmed, because the column is free text
 * arriving from a spreadsheet — `'None'` and `' compound '` are the same legacy
 * value as their canonical forms, and a genuine name keeps its own casing.
 */
export function activationExercise(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return NON_EXERCISE_VALUES.has(trimmed.toLowerCase()) ? undefined : trimmed;
}
