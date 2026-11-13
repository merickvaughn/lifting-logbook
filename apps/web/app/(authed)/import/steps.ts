import type { ImportKind } from '@lifting-logbook/types';

export const KIND_LABEL: Record<ImportKind, string> = {
  'lift-records': 'Lift History',
  'training-maxes': 'Training Maxes',
  'strength-goals': 'Strength Goals',
  'program-spec': 'Program',
};

export const ALL_KINDS: ImportKind[] = [
  'lift-records',
  'training-maxes',
  'strength-goals',
  'program-spec',
];

/** A program the wizard can import into. */
export type ImportTarget = {
  id: string;
  name: string;
  /** A built-in template rather than a custom program. Its spec can't be written to. */
  isTemplate?: boolean;
};

/**
 * What can be imported into a program. Lift history, training maxes and strength
 * goals are stored per program under any program name, but a template's spec is
 * built in, so the API rejects a program-spec commit to one.
 */
export function kindsForTarget(target: ImportTarget | undefined): ImportKind[] {
  return target?.isTemplate ? ALL_KINDS.filter((kind) => kind !== 'program-spec') : ALL_KINDS;
}

/**
 * Smart Import wizard step constants.
 * Use these instead of bare integers when reading or setting the step state.
 */
export const Step = {
  SOURCE: 0,
  ANALYZING: 1,
  CLASSIFY: 2,
  MAP_COLUMNS: 3,
  REVIEW: 4,
  ASSIGN: 5,
  PREVIEW: 6,
  DONE: 7,
} as const;

export type StepValue = (typeof Step)[keyof typeof Step];

export const STEP_LABELS = [
  'Source',
  'Analyzing',
  'Classify',
  'Map columns',
  'Review',
  'Assign',
  'Preview',
  'Done',
] as const;

/** The steps a run shows: Assign only for a lift-records import with the step on (#1256). */
export function visibleSteps(assign: boolean): StepValue[] {
  return Object.values(Step).filter((s) => assign || s !== Step.ASSIGN);
}

/** The step Back goes to: the visible step before, except Classify, which goes back to Source past Analyzing. */
export function previousStep(step: StepValue, assign: boolean): StepValue {
  if (step === Step.CLASSIFY) return Step.SOURCE;
  const steps = visibleSteps(assign);
  return steps[steps.indexOf(step) - 1] ?? Step.SOURCE;
}

// Sanity check: ensure Step values match STEP_LABELS indices
if (Object.values(Step).some((v) => typeof v === 'number' && v >= STEP_LABELS.length)) {
  throw new Error('Step constant exceeds STEP_LABELS length');
}
