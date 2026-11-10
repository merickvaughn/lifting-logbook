/**
 * Updates the dashboard macrocycle: increments macrocycleNum, updates macrocycleDate to the next Monday (at least 7 days after previous), and updates sheetLink.
 * @param prevMacrocycle MacrocycleDashboard
 * @param overrides Optional overrides for weekday or start date
 * @returns Updated MacrocycleDashboard
 */

export interface UpdateMacrocycleOverrides {
  targetWeekday?: string;
  today?: Date;
  overrideDate?: Date;
  updateStartWeekday?: boolean;
  /**
   * The new macrocycle's number, allocated by the caller from what's stored. Without it the
   * number is the previous one + 1, which can land on a number already taken (ADR-042).
   */
  macrocycleNum?: number;
}
