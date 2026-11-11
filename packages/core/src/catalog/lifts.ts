import { Lift, MuscleTargets, ProgressionType } from '@lifting-logbook/types';

/**
 * A built-in lift's default progression: its type and, where the type needs one, its rep
 * range. It applies to a lift with no value of its own when the lifter hasn't set a default
 * (see `resolveProgression`). It carries no increment: off-program the increment falls back
 * to the lifter's `defaultWeightIncrement`, not to the catalog. `rpe` is never a catalog
 * default, because it isn't selectable on a lift until per-set RPE logging exists.
 */
export interface CatalogProgression {
  type: Exclude<ProgressionType, 'rpe'>;
  repsLow?: number;
  repsHigh?: number;
}

// The catalog defaults are a heuristic, not a citation, chosen by role classification:
// `compound` lifts on straight sets of 5 (Rippetoe's Starting Strength), `accessory` lifts
// on a common 8–12 double-progression range, and the loaded carry, which is measured in
// distance or time rather than reps, on `manual`.
const LINEAR_5: CatalogProgression = { type: 'linear', repsHigh: 5 };
const DOUBLE_8_12: CatalogProgression = { type: 'double', repsLow: 8, repsHigh: 12 };
const MANUAL: CatalogProgression = { type: 'manual' };

/**
 * A built-in catalog entry: a {@link Lift} plus the data only built-ins carry.
 *
 *   - muscles: default primary/secondary muscle groups for weekly set counts. A user can
 *     override them per lift (`LiftMetadata`). Defaults attach to the name, so a custom
 *     lift reads them only when it shares a built-in's name or alias. See ADR-036.
 *   - aliases: other names the built-in program presets use for this lift (e.g.
 *     "Calf Raises"). `builtInLiftFor` recognizes them — so they classify and count — but
 *     they are deliberately NOT in `DEFAULT_SLOT_MAP`, which also drives the logger's
 *     bodyweight detection and the custom-lift collision guard, each a separate decision
 *     (issue #1015). Aliasing "Weighted Pull-ups" there, for instance, would flip it to a
 *     bodyweight-component lift. Import alone accepts them, through `buildImportSlotMap`,
 *     so a preset's own rows can be restored (issue #947).
 *   - progression: the lift's default progression type and rep range (issue #1209); see
 *     {@link CatalogProgression}.
 */
export interface CatalogLift extends Lift {
  muscles: MuscleTargets;
  aliases?: readonly string[];
  progression: CatalogProgression;
}

/**
 * Curated seed catalog of common barbell, dumbbell, and bodyweight movements.
 * Each entry carries a training-role `classification` (compound | accessory), a
 * `movementProfile` describing three orthogonal axes, and default `muscles`:
 *
 *   - patterns:     kinesiological pattern tags (combine to express a movement)
 *   - jointActions: anatomical joint actions driven through the range of motion
 *   - complexity:   single-joint (simple) vs multi-joint (compound) mechanics
 *
 * Patterns combine to express a movement:
 *   push + vertical   = overhead press / dip pattern
 *   push + horizontal = bench press pattern
 *   pull + vertical   = chin-up / lat pulldown / upright row pattern
 *   pull + horizontal = row pattern
 *   squat             = knee-dominant squat pattern
 *   hinge             = hip hinge pattern (deadlift, RDL)
 *   carry             = loaded carry pattern
 *
 * Vertical and horizontal describe the line of force relative to the TORSO, not the
 * floor: a bench press is a horizontal push although the lifter lies down, and a dip is
 * a vertical push because the hands drive down along the torso. A bench inclined θ°
 * presses at (90 − θ)° to the torso, so an incline of 45° or less presses at least as
 * close to perpendicular as to parallel and stays horizontal — what the incline mainly
 * changes is regional chest emphasis, which is a muscle question, not a pattern one.
 * Single-joint moves carry no direction: a curl (cable curl, leg curl) flexes a joint
 * toward the body, so it keeps a lone `pull` tag; a triceps extension (pushdown, skull
 * crusher) extends one away, so it keeps a lone `push`; and a raise or fly (lateral raise,
 * calf raise, cable fly) carries no tag at all — none earns a direction row. See ADR-036.
 *
 * NOTE: movement `complexity` (simple|compound) is distinct from role `classification`
 * (compound|accessory). A Goblet Squat is movement-`compound` yet role-`accessory`.
 */
export const LIFT_CATALOG: readonly CatalogLift[] = [
  // --- Squat pattern ---
  {
    id: 'back-squat', name: 'Back Squat', classification: 'compound',
    movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Quads', 'Glutes'], secondary: ['Adductors', 'Lower Back'] },
    progression: LINEAR_5,
  },
  {
    id: 'front-squat', name: 'Front Squat', classification: 'compound',
    movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Quads'], secondary: ['Glutes', 'Upper Back', 'Core'] },
    progression: LINEAR_5,
  },
  {
    id: 'goblet-squat', name: 'Goblet Squat', classification: 'accessory',
    movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Quads'], secondary: ['Glutes', 'Core'] },
    progression: DOUBLE_8_12,
  },

  // --- Hip hinge pattern ---
  {
    id: 'deadlift', name: 'Deadlift', classification: 'compound',
    movementProfile: { patterns: ['hinge'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Glutes', 'Hamstrings', 'Lower Back'], secondary: ['Quads', 'Traps', 'Upper Back', 'Forearms'] },
    progression: LINEAR_5,
  },
  {
    id: 'romanian-deadlift', name: 'Romanian Deadlift', classification: 'compound',
    movementProfile: { patterns: ['hinge'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Hamstrings', 'Glutes'], secondary: ['Lower Back'] },
    progression: LINEAR_5,
  },
  {
    id: 'hip-thrust', name: 'Hip Thrust', classification: 'accessory',
    movementProfile: { patterns: ['hinge'], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Glutes'], secondary: ['Hamstrings'] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'kb-swing', name: 'Kettlebell Swing', classification: 'accessory',
    movementProfile: { patterns: ['hinge'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Glutes', 'Hamstrings'], secondary: ['Lower Back', 'Core'] },
    progression: DOUBLE_8_12,
  },

  // --- Vertical push pattern ---
  {
    id: 'overhead-press', name: 'Overhead Press', classification: 'compound',
    movementProfile: { patterns: ['push', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Front Delts'], secondary: ['Triceps', 'Side Delts'] },
    progression: LINEAR_5,
  },
  {
    id: 'push-press', name: 'Push Press', classification: 'compound',
    movementProfile: { patterns: ['push', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Front Delts'], secondary: ['Triceps', 'Side Delts', 'Quads'] },
    progression: LINEAR_5,
  },
  // A dip drives the hands down along the torso — a vertical push by the torso rule above,
  // even though its chest emphasis gets it filed with bench pressing in some programs.
  // The chest emphasis lives in `muscles`, where it belongs.
  {
    id: 'dip', name: 'Dip', classification: 'compound',
    movementProfile: { patterns: ['push', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    isBodyweightComponent: true,
    muscles: { primary: ['Chest', 'Triceps'], secondary: ['Front Delts'] },
    progression: LINEAR_5,
  },

  // --- Horizontal push pattern ---
  {
    id: 'bench-press', name: 'Bench Press', classification: 'compound',
    aliases: ['Flat Bench Press'],
    movementProfile: { patterns: ['push', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Chest'], secondary: ['Triceps', 'Front Delts'] },
    progression: LINEAR_5,
  },
  {
    id: 'incline-bench-press', name: 'Incline Bench Press', classification: 'compound',
    movementProfile: { patterns: ['push', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Chest'], secondary: ['Front Delts', 'Triceps'] },
    progression: LINEAR_5,
  },
  {
    id: 'incline-db-press', name: 'Incline Dumbbell Press', classification: 'accessory',
    movementProfile: { patterns: ['push', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Chest'], secondary: ['Front Delts', 'Triceps'] },
    progression: DOUBLE_8_12,
    aliases: ['Incline DB Press'], // leangains
  },

  // --- Vertical pull pattern ---
  {
    id: 'chin-up', name: 'Chin-up', classification: 'compound',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    isBodyweightComponent: true,
    muscles: { primary: ['Lats'], secondary: ['Biceps', 'Upper Back'] },
    progression: LINEAR_5,
  },
  {
    id: 'pull-up', name: 'Pull-up', classification: 'compound',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    isBodyweightComponent: true,
    muscles: { primary: ['Lats'], secondary: ['Biceps', 'Upper Back'] },
    progression: LINEAR_5,
    aliases: ['Weighted Pull-ups'], // leangains, rpt
  },
  {
    id: 'lat-pulldown', name: 'Lat Pulldown', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Lats'], secondary: ['Biceps'] },
    progression: DOUBLE_8_12,
  },
  // The bar travels up along the torso — a vertical pull by the torso rule above.
  {
    id: 'upright-row', name: 'Upright Row', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['abduction'], complexity: 'compound' },
    muscles: { primary: ['Side Delts', 'Traps'], secondary: ['Biceps'] },
    progression: DOUBLE_8_12,
  },

  // --- Horizontal pull pattern ---
  {
    id: 'barbell-row', name: 'Barbell Row', classification: 'compound',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Upper Back', 'Lats'], secondary: ['Biceps', 'Rear Delts', 'Lower Back'] },
    progression: LINEAR_5,
  },
  {
    id: 'db-row', name: 'Dumbbell Row', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Lats', 'Upper Back'], secondary: ['Biceps', 'Rear Delts'] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'cable-row', name: 'Cable Row', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Upper Back', 'Lats'], secondary: ['Biceps', 'Rear Delts'] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'face-pull', name: 'Face Pull', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['external-rotation'], complexity: 'simple' },
    muscles: { primary: ['Rear Delts'], secondary: ['Upper Back'] },
    progression: DOUBLE_8_12,
  },

  // --- Carry pattern ---
  // A loaded carry is a whole-body stabilization task (hence movement-`compound`) with no prime
  // mover driven through a range of motion — the empty `jointActions` is deliberate, not an omission.
  {
    id: 'farmers-carry', name: "Farmer's Carry", classification: 'compound',
    movementProfile: { patterns: ['carry'], jointActions: [], complexity: 'compound' },
    muscles: { primary: ['Forearms', 'Traps'], secondary: ['Core'] },
    progression: MANUAL,
  },

  // --- Common accessories ---
  {
    id: 'cable-curl', name: 'Cable Curl', classification: 'accessory',
    movementProfile: { patterns: ['pull'], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Biceps'], secondary: ['Forearms'] },
    progression: DOUBLE_8_12,
  },
  // A lateral raise abducts the arm; it presses nothing and pulls nothing, so it carries no tag.
  {
    id: 'lateral-raise', name: 'Lateral Raise', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['abduction'], complexity: 'simple' },
    muscles: { primary: ['Side Delts'], secondary: [] },
    progression: DOUBLE_8_12,
    aliases: ['Lateral Raises'], // leangains
  },
  // A curl, like Cable Curl above: a lone `pull` (knee flexion toward the body), no direction.
  {
    id: 'leg-curl', name: 'Leg Curl', classification: 'accessory',
    movementProfile: { patterns: ['pull'], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Hamstrings'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'calf-raise', name: 'Calf Raise', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Calves'], secondary: [] },
    progression: DOUBLE_8_12,
    aliases: ['Calf Raises'], // leangains, rpt
  },

  // --- Focus work accessories (issue #1054) ---
  {
    id: 'arnold-press', name: 'Arnold Press', classification: 'accessory',
    movementProfile: { patterns: ['push', 'vertical'], jointActions: ['flexion', 'extension', 'external-rotation', 'internal-rotation'], complexity: 'compound' },
    muscles: { primary: ['Front Delts'], secondary: ['Side Delts', 'Triceps'] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'hammer-curl', name: 'Hammer Curl', classification: 'accessory',
    movementProfile: { patterns: ['pull'], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Biceps'], secondary: ['Forearms'] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'incline-db-curl', name: 'Incline Dumbbell Curl', classification: 'accessory',
    movementProfile: { patterns: ['pull'], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Biceps'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  // Triceps extensions mirror the curl rule: a lone `push` (the elbow extends away from the
  // body), no direction row.
  {
    id: 'rope-pushdown', name: 'Rope Pushdown', classification: 'accessory',
    movementProfile: { patterns: ['push'], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Triceps'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'overhead-extension', name: 'Overhead Extension', classification: 'accessory',
    movementProfile: { patterns: ['push'], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Triceps'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'skull-crusher', name: 'Skull Crusher', classification: 'accessory',
    movementProfile: { patterns: ['push'], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Triceps'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'chest-supported-row', name: 'Chest-Supported Row', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Upper Back', 'Lats'], secondary: ['Biceps', 'Rear Delts'] },
    progression: DOUBLE_8_12,
  },
  // Single-joint shoulder extension: a lone `pull`, like a curl, with no direction row.
  {
    id: 'straight-arm-pulldown', name: 'Straight-Arm Pulldown', classification: 'accessory',
    movementProfile: { patterns: ['pull'], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Lats'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  // A fly adducts the arm across the body; like a raise, it carries no tag.
  {
    id: 'cable-fly', name: 'Cable Fly', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['adduction'], complexity: 'simple' },
    muscles: { primary: ['Chest'], secondary: ['Front Delts'] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'seated-calf-raise', name: 'Seated Calf Raise', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Calves'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'cable-pull-through', name: 'Cable Pull-Through', classification: 'accessory',
    movementProfile: { patterns: ['hinge'], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Glutes'], secondary: ['Hamstrings'] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'cable-crunch', name: 'Cable Crunch', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Core'], secondary: [] },
    progression: DOUBLE_8_12,
  },
  {
    id: 'hanging-leg-raise', name: 'Hanging Leg Raise', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Core'], secondary: [] },
    progression: DOUBLE_8_12,
  },
];
