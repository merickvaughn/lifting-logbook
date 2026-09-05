import { CycleDashboard, SpreadsheetCell } from "@src/core/models";
import {
  CYCLE_DATE_KEY,
  CYCLE_NUM_KEY,
  CYCLE_START_WEEKDAY_KEY,
  CYCLE_UNIT_KEY,
  PROGRAM_KEY,
  SHEET_NAME_KEY,
} from "@src/core/constants/config";
/**
 * Converts a CycleDashboard object to a 2D array (for writing to a sheet)
 * @param {CycleDashboard} obj
 * @returns {any[][]} 2D array with [key, value] pairs
 */
export function mapCycleDashboard(obj: CycleDashboard): SpreadsheetCell[][] {
  return [
    ["Key", "Value"],
    [PROGRAM_KEY, obj.program],
    [CYCLE_UNIT_KEY, obj.cycleUnit],
    [CYCLE_NUM_KEY, obj.cycleNum],
    [CYCLE_DATE_KEY, obj.cycleDate],
    [SHEET_NAME_KEY, obj.sheetName],
    [CYCLE_START_WEEKDAY_KEY, obj.cycleStartWeekday],
  ];
}
