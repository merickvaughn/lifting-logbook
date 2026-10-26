import type {
  FocusArea,
  FocusOverlap,
  FocusProgression,
  FocusSelection,
} from '@lifting-logbook/types';

// Display helpers for focus work (#1053), shared by the pages that show focus blocks.

/** Each area's hue, from the design prototype (docs/mockups/focus-work.html). */
const FOCUS_AREA_HUE: Record<FocusArea, number> = {
  Shoulders: 245,
  Biceps: 150,
  Triceps: 25,
  Back: 300,
  Chest: 200,
  Calves: 70,
  Glutes: 350,
  Core: 115,
};

/**
 * An area's color. The default lightness is the solid bar and dot color, dark enough for
 * white text; a lower one gives a darker shade of the same hue.
 */
export function focusAreaColor(area: FocusArea, lightness = 0.52): string {
  return `oklch(${lightness} 0.12 ${FOCUS_AREA_HUE[area]})`;
}

export const FOCUS_SELECTION_LABELS: Record<FocusSelection, string> = {
  rules: 'Rules',
  rotate: 'Rotate',
  fixed: 'Fixed',
  pick: 'I pick',
};

export const FOCUS_OVERLAP_LABELS: Record<FocusOverlap, string> = {
  swap: 'Swap',
  reduce: 'Reduce',
  skip: 'Skip',
  anyway: 'Do it anyway',
};

export const FOCUS_PROGRESSION_LABELS: Record<FocusProgression, string> = {
  double: 'Double progression',
  fixed: 'Fixed',
  tm: '% of TM',
  rpe: 'RPE',
};
