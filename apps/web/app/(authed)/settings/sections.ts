/**
 * The settings sections, in display order.
 *
 * Single source of truth for the settings sub-nav ({@link SettingsNav}) and the
 * `/settings` hub cards, so the label/route pairs can never drift between the
 * two surfaces (#679).
 */
export interface SettingsSection {
  /** Route for the section page. */
  href: string;
  /** Nav label and hub-card title. */
  label: string;
  /** One-line summary shown on the hub card. */
  description: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    href: '/settings/training-maxes',
    label: 'Training Maxes',
    description:
      'View, update, and track the history of the working maxes that drive every calculated lift.',
  },
  {
    href: '/settings/strength-goals',
    label: 'Strength Goals',
    description:
      'Set target weights or bodyweight ratios for each lift and track your progress toward them.',
  },
  {
    href: '/settings/schedule',
    label: 'Schedule',
    description:
      'Choose which days of the week you train so generated workouts land on the right dates.',
  },
  {
    href: '/settings/weight-rounding',
    label: 'Weight Rounding',
    description:
      'Set the smallest weight increment used when rounding calculated loads to a loadable weight.',
  },
  {
    href: '/settings/progression',
    label: 'Progression',
    description:
      "Choose how a lift's max moves when the lift has no progression of its own.",
  },
  {
    href: '/settings/units',
    label: 'Units',
    description: 'Choose lbs or kg for how weights are displayed across the app.',
  },
  {
    href: '/settings/data',
    label: 'Data',
    description: 'Download a copy of everything in your logbook.',
  },
];
