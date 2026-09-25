/** Classification of a lift by primary training role. */
export type LiftClassification = 'compound' | 'accessory';

/**
 * Movement pattern tags used to classify a lift.
 * Tags combine to describe a pattern — e.g., push + vertical = overhead press pattern.
 */
export type MovementTag = 'push' | 'pull' | 'vertical' | 'horizontal' | 'hinge' | 'carry' | 'squat';

/**
 * Anatomical joint actions a lift drives. An axis orthogonal to {@link MovementTag}
 * (a kinesiological pattern) and {@link LiftClassification} (a training role).
 */
export type JointAction =
  | 'flexion'
  | 'extension'
  | 'internal-rotation'
  | 'external-rotation'
  | 'abduction'
  | 'adduction';

/**
 * Movement complexity: single-joint (`simple`) vs multi-joint (`compound`).
 *
 * NOTE: deliberately distinct from {@link LiftClassification}. Complexity describes the
 * *mechanics* (how many joints move); classification describes the *training role*
 * (`compound` primary vs `accessory`). A Goblet Squat is movement-`compound` (knees + hips)
 * yet role-`accessory`. Both axes are kept independently.
 */
export type MovementComplexity = 'simple' | 'compound';

/**
 * Combined movement description for a lift: pattern + joint actions + complexity.
 * Preconfigured for catalog entries and editable for custom lifts.
 *
 * See {@link MovementComplexity} for why `complexity` is not the same as
 * {@link LiftClassification}.
 */
export interface MovementProfile {
  /** Movement pattern tags (e.g. push + vertical). Formerly `Lift.movementTags`. */
  patterns: MovementTag[];
  /** Anatomical joint actions driven by the lift. */
  jointActions: JointAction[];
  /** Single- vs multi-joint mechanics. */
  complexity: MovementComplexity;
}

/**
 * Muscle groups used to count weekly set volume, ordered upper → lower body.
 *
 * The granularity follows the groups hypertrophy volume guidance is written for: the
 * shoulder splits into front, side and rear delts and the back into lats, upper back,
 * traps and lower back, because those regions answer to different movements — a program
 * can press heavily and still give the side delts almost no direct work. See ADR-036.
 */
export const MUSCLE_GROUPS = [
  'Chest',
  'Front Delts',
  'Side Delts',
  'Rear Delts',
  'Triceps',
  'Biceps',
  'Forearms',
  'Lats',
  'Upper Back',
  'Traps',
  'Lower Back',
  'Core',
  'Quads',
  'Hamstrings',
  'Glutes',
  'Adductors',
  'Calves',
] as const;

export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

/**
 * The muscles a lift trains, for weekly set counts: a working set counts 1 toward each
 * `primary` muscle and ½ toward each `secondary` one (the "fractional" counting method —
 * see ADR-036). A muscle appears in one list, never both.
 */
export interface MuscleTargets {
  primary: readonly MuscleGroup[];
  secondary: readonly MuscleGroup[];
}

/** A first-class exercise domain object. */
export interface Lift {
  id: string;
  name: string;
  classification: LiftClassification;
  /** Combined pattern + joint-action + complexity profile. */
  movementProfile: MovementProfile;
  /** True when body weight contributes to the total load (e.g. chin-ups, dips). */
  isBodyweightComponent?: boolean;
  /** True for user-created lifts; absent/false for built-in catalog entries. */
  isCustom?: boolean;
}

/**
 * A user-created lift. Persisted per user and resolved alongside the built-in
 * catalog (custom entries take precedence). `id` is a stable uuid (the REST key),
 * independent of `name` so a lift can be renamed without breaking references.
 */
export interface CustomLift extends Lift {
  userId: string;
  isCustom: true;
  createdAt: Date;
}

/**
 * A named lift. Typed as a branded string so new lifts can be added without
 * a code change, while still enabling autocomplete from LIFT_NAMES.
 */
export type LiftName = string & {};

/** Canonical set of known lifts, used for validation and autocomplete. */
export const LIFT_NAMES = [
  // 5/3/1 big four
  'Squat',
  'Bench Press',
  'Deadlift',
  'Overhead Press',
  // RPT primary
  'Barbell Row',
  'Chin-up',
  // RPT accessory
  'Cable Curls',
  'Calf Raise',
  'Dips',
  // Balance / lagging body parts
  'Face Pulls',
  'Cable Lat Raise',
  'Upright Row',
] as const satisfies LiftName[];

/** Unit of measurement for weights. */
export type WeightUnit = 'lbs' | 'kg';

/** A single body weight observation recorded at session start. */
export interface BodyWeightEntry {
  date: Date;
  weight: number;
  unit: WeightUnit;
}

/** Week number within a training cycle (1-based). */
export type WeekNumber = number;

/** Declares the character of a training week. */
export type WeekType = 'training' | 'test' | 'deload';

/**
 * Cycle number within a training program.
 * 1-indexed: the first cycle is cycle 1.
 */
export type CycleNumber = number;

/** Strength classification tier relative to bodyweight-based standards. */
export type StrengthTier = 'intermediate' | 'advanced' | 'elite';

/** A bodyweight-multiplier standard for a specific lift and tier. */
export interface StrengthStandard {
  liftId: string;
  tier: StrengthTier;
  multiplier: number;
}

/** A per-user strength goal for a specific lift and tier. */
export interface StrengthGoal {
  userId: string;
  liftId: string;
  tier: StrengthTier;
  /** Overrides the system-default multiplier when set. */
  multiplierOverride?: number;
  targetDate?: Date;
  observedDate?: Date;
}
