import { Lift, MuscleTargets } from '@lifting-logbook/types';

/**
 * A built-in catalog entry: a {@link Lift} plus the data only built-ins carry.
 *
 *   - muscles: default primary/secondary muscle groups for weekly set counts. A user can
 *     override them per lift (`LiftMetadata`); custom lifts have no defaults. See ADR-036.
 *   - aliases: other names the built-in program presets use for this lift (e.g.
 *     "Calf Raises"). `builtInLiftFor` recognizes them — so they classify and count — but
 *     they are deliberately NOT import slot names: `DEFAULT_SLOT_MAP` also drives the
 *     logger's bodyweight detection, import validation and the custom-lift collision
 *     guard, each a separate decision (issue #1015). Aliasing "Weighted Pull-ups" there,
 *     for instance, would flip it to a bodyweight-component lift.
 */
export interface CatalogLift extends Lift {
  muscles: MuscleTargets;
  aliases?: readonly string[];
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
 * changes is regional chest emphasis, which is a muscle question, not a pattern one. Single-joint raises and curls (lateral raise, calf raise, leg curl) carry no
 * push/pull direction. See ADR-036.
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
  },
  {
    id: 'front-squat', name: 'Front Squat', classification: 'compound',
    movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Quads'], secondary: ['Glutes', 'Upper Back', 'Core'] },
  },
  {
    id: 'goblet-squat', name: 'Goblet Squat', classification: 'accessory',
    movementProfile: { patterns: ['squat'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Quads'], secondary: ['Glutes', 'Core'] },
  },

  // --- Hip hinge pattern ---
  {
    id: 'deadlift', name: 'Deadlift', classification: 'compound',
    movementProfile: { patterns: ['hinge'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Glutes', 'Hamstrings', 'Lower Back'], secondary: ['Quads', 'Traps', 'Upper Back', 'Forearms'] },
  },
  {
    id: 'romanian-deadlift', name: 'Romanian Deadlift', classification: 'compound',
    movementProfile: { patterns: ['hinge'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Hamstrings', 'Glutes'], secondary: ['Lower Back'] },
  },
  {
    id: 'hip-thrust', name: 'Hip Thrust', classification: 'accessory',
    movementProfile: { patterns: ['hinge'], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Glutes'], secondary: ['Hamstrings'] },
  },
  {
    id: 'kb-swing', name: 'Kettlebell Swing', classification: 'accessory',
    movementProfile: { patterns: ['hinge'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Glutes', 'Hamstrings'], secondary: ['Lower Back', 'Core'] },
  },

  // --- Vertical push pattern ---
  {
    id: 'overhead-press', name: 'Overhead Press', classification: 'compound',
    movementProfile: { patterns: ['push', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Front Delts'], secondary: ['Triceps', 'Side Delts'] },
  },
  {
    id: 'push-press', name: 'Push Press', classification: 'compound',
    movementProfile: { patterns: ['push', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Front Delts'], secondary: ['Triceps', 'Side Delts', 'Quads'] },
  },
  // A dip drives the hands down along the torso — a vertical push by the torso rule above,
  // even though its chest emphasis gets it filed with bench pressing in some programs.
  // The chest emphasis lives in `muscles`, where it belongs.
  {
    id: 'dip', name: 'Dip', classification: 'compound',
    movementProfile: { patterns: ['push', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    isBodyweightComponent: true,
    muscles: { primary: ['Chest', 'Triceps'], secondary: ['Front Delts'] },
  },

  // --- Horizontal push pattern ---
  {
    id: 'bench-press', name: 'Bench Press', classification: 'compound',
    movementProfile: { patterns: ['push', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Chest'], secondary: ['Triceps', 'Front Delts'] },
  },
  {
    id: 'incline-bench-press', name: 'Incline Bench Press', classification: 'compound',
    movementProfile: { patterns: ['push', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Chest'], secondary: ['Front Delts', 'Triceps'] },
  },
  {
    id: 'incline-db-press', name: 'Incline Dumbbell Press', classification: 'accessory',
    movementProfile: { patterns: ['push', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Chest'], secondary: ['Front Delts', 'Triceps'] },
    aliases: ['Incline DB Press'], // leangains
  },

  // --- Vertical pull pattern ---
  {
    id: 'chin-up', name: 'Chin-up', classification: 'compound',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    isBodyweightComponent: true,
    muscles: { primary: ['Lats'], secondary: ['Biceps', 'Upper Back'] },
  },
  {
    id: 'pull-up', name: 'Pull-up', classification: 'compound',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    isBodyweightComponent: true,
    muscles: { primary: ['Lats'], secondary: ['Biceps', 'Upper Back'] },
    aliases: ['Weighted Pull-ups'], // leangains, rpt
  },
  {
    id: 'lat-pulldown', name: 'Lat Pulldown', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Lats'], secondary: ['Biceps'] },
  },
  // The bar travels up along the torso — a vertical pull by the torso rule above.
  {
    id: 'upright-row', name: 'Upright Row', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'vertical'], jointActions: ['abduction'], complexity: 'compound' },
    muscles: { primary: ['Side Delts', 'Traps'], secondary: ['Biceps'] },
  },

  // --- Horizontal pull pattern ---
  {
    id: 'barbell-row', name: 'Barbell Row', classification: 'compound',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Upper Back', 'Lats'], secondary: ['Biceps', 'Rear Delts', 'Lower Back'] },
  },
  {
    id: 'db-row', name: 'Dumbbell Row', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Lats', 'Upper Back'], secondary: ['Biceps', 'Rear Delts'] },
  },
  {
    id: 'cable-row', name: 'Cable Row', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['flexion', 'extension'], complexity: 'compound' },
    muscles: { primary: ['Upper Back', 'Lats'], secondary: ['Biceps', 'Rear Delts'] },
  },
  {
    id: 'face-pull', name: 'Face Pull', classification: 'accessory',
    movementProfile: { patterns: ['pull', 'horizontal'], jointActions: ['external-rotation'], complexity: 'simple' },
    muscles: { primary: ['Rear Delts'], secondary: ['Upper Back'] },
  },

  // --- Carry pattern ---
  // A loaded carry is a whole-body stabilization task (hence movement-`compound`) with no prime
  // mover driven through a range of motion — the empty `jointActions` is deliberate, not an omission.
  {
    id: 'farmers-carry', name: "Farmer's Carry", classification: 'compound',
    movementProfile: { patterns: ['carry'], jointActions: [], complexity: 'compound' },
    muscles: { primary: ['Forearms', 'Traps'], secondary: ['Core'] },
  },

  // --- Common accessories ---
  {
    id: 'cable-curl', name: 'Cable Curl', classification: 'accessory',
    movementProfile: { patterns: ['pull'], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Biceps'], secondary: ['Forearms'] },
  },
  // A lateral raise abducts the arm; it presses nothing, so it carries no push/pull direction.
  {
    id: 'lateral-raise', name: 'Lateral Raise', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['abduction'], complexity: 'simple' },
    muscles: { primary: ['Side Delts'], secondary: [] },
    aliases: ['Lateral Raises'], // leangains
  },
  {
    id: 'leg-curl', name: 'Leg Curl', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['flexion'], complexity: 'simple' },
    muscles: { primary: ['Hamstrings'], secondary: [] },
  },
  {
    id: 'calf-raise', name: 'Calf Raise', classification: 'accessory',
    movementProfile: { patterns: [], jointActions: ['extension'], complexity: 'simple' },
    muscles: { primary: ['Calves'], secondary: [] },
    aliases: ['Calf Raises'], // leangains, rpt
  },
];
