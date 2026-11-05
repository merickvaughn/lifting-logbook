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
  PREVIEW: 5,
  DONE: 6,
} as const;

export const STEP_LABELS = [
  'Source',
  'Analyzing',
  'Classify',
  'Map columns',
  'Review',
  'Preview',
  'Done',
] as const;

// Sanity check: ensure Step values match STEP_LABELS indices
if (Object.values(Step).some((v) => typeof v === 'number' && v >= STEP_LABELS.length)) {
  throw new Error('Step constant exceeds STEP_LABELS length');
}
