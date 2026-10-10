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
}
