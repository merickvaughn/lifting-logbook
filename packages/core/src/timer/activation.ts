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
 * **Membership rule:** a value that appears in the `activation` column of a
 * corpus this repo actually ships — a built-in preset, the program editor's
 * default row, or a program-spec import fixture — and is not a movement name.
 * Nothing else qualifies. That rule is checkable, and
 * `tests/core/timer/activation.test.ts` checks it: it reads both corpora live
 * and asserts every non-name value they carry resolves to "no activation".
 *
 * | Value         | Shipped corpus it appears in                                       |
 * |---------------|--------------------------------------------------------------------|
 * | `''`          | the column absent on import; `rpt_program_spec` rows with no drill  |
 * | `'compound'`  | `PRESET_BASE_SPECS` (leangains / rpt / 5-3-1); the editor's default |
 * | `'isolation'` | `PRESET_BASE_SPECS` (`Leg Curl`, `Calf Raises`)                     |
 * | `'none'`      | the e2e mock API's program spec                                     |
 * | `'n/a'`       | `tests/fixtures/rpt_program_spec.csv` — the marker a real exported  |
 * |               | sheet uses for "this lift has no activation drill"                  |
 *
 * `'main'`, `'standard'` and `'accessory'` are deliberately absent: they occur
 * only in *API* test fixtures, never in an `activation` column, so adding them
 * would be reading the set off the wrong class. A lifter whose imported column
 * literally says "main" gets a phase named "main", and turns it off with a
 * per-lift override of `activation: 0`.
 *
 * The set is load-bearing only until the column is disambiguated upstream —
 * see ADR-035 Amendment 2's follow-up.
 */
const NON_EXERCISE_VALUES: ReadonlySet<string> = new Set([
  '',
  'compound',
  'isolation',
  'none',
  'n/a',
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
