import type { MacrocycleStatus } from '@lifting-logbook/types';

// The import prototype's wording (docs/mockups/import-macrocycle-assignment.html), plus
// "Status unknown" for history whose status nothing records (proposal decision 18).
export const STATUS_LABEL: Record<MacrocycleStatus, string> = {
  completed: 'Completed',
  overran: 'Ran past its length',
  abandoned: 'Unfinished',
  'in-progress': 'In progress',
  unknown: 'Status unknown',
};

/** A mark beside each status, so it isn't told by color alone. */
export const STATUS_MARK: Record<MacrocycleStatus | 'unset', string> = {
  completed: '✓',
  overran: '⏱',
  abandoned: '○',
  'in-progress': '▶',
  unknown: '–',
  unset: '?',
};
