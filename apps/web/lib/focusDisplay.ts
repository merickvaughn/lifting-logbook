import type { FocusArea } from '@lifting-logbook/types';

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
 * An area's color (#1053). The default lightness is the solid bar and dot color, dark
 * enough for white text; a lower one gives a darker shade of the same hue.
 */
export function focusAreaColor(area: FocusArea, lightness = 0.52): string {
  return `oklch(${lightness} 0.12 ${FOCUS_AREA_HUE[area]})`;
}
