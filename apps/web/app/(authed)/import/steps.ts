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
