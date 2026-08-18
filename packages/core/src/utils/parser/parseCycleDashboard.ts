import { CycleDashboard, SpreadsheetCell, Weekday } from "@src/core/models";
import {
  CYCLE_DATE_KEY,
  CYCLE_NUM_KEY,
  CYCLE_START_WEEKDAY_KEY,
  CYCLE_UNIT_KEY,
  PROGRAM_KEY,
  SHEET_NAME_KEY,
} from "@src/core/constants";
import { parseDateStringUTC, toUTCMidnight } from "../jsUtil";

/**
 * Parses a 2D array (from CSV or sheet) into a CycleDashboard object.
 * @param {SpreadsheetCell[][]} data - 2D array with headers in column 0 and values in column 1
 * @returns {CycleDashboard}
 */
function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export function parseCycleDashboard(data: SpreadsheetCell[][]): CycleDashboard {
  const map: Record<string, SpreadsheetCell | undefined> = {};
  data.forEach(([key, value]) => {
    map[String(key)] = value;
  });

  const programRaw = map[PROGRAM_KEY];
  const cycleUnitRaw = map[CYCLE_UNIT_KEY];
  const cycleNumRaw = map[CYCLE_NUM_KEY];
  const cycleDateRaw = map[CYCLE_DATE_KEY];
  const sheetNameRaw = map[SHEET_NAME_KEY];
  const cycleStartWeekdayRaw = map[CYCLE_START_WEEKDAY_KEY];

  const program = String(programRaw ?? "");
  const cycleUnit = String(cycleUnitRaw ?? "");
  const cycleNum = Number(cycleNumRaw);
  // Non-ISO date cells (e.g. "1/5/2026") parse at LOCAL midnight via bare
  // `new Date(string)`, landing on the WRONG UTC calendar day on any host
  // ahead of UTC -- same bug class as issue #894 (see jsUtil.ts's
  // parseDateStringUTC doc comment). toUTCMidnight normalizes the
  // time-of-day, matching the convention parseLiftRecords.ts /
  // parseTrainingMaxes.ts already use (issue #899).
  const cycleDate = toUTCMidnight(parseDateStringUTC(String(cycleDateRaw ?? "")));
  const sheetName = String(sheetNameRaw ?? "");
  const cycleStartWeekday = toTitleCase(
    String(cycleStartWeekdayRaw ?? ""),
  ) as Weekday;

  if (program.length === 0) {
    throw new Error(`Invalid ${PROGRAM_KEY} value: ${String(programRaw)}`);
  }
  if (cycleUnit.length === 0) {
    throw new Error(`Invalid ${CYCLE_UNIT_KEY} value: ${String(cycleUnitRaw)}`);
  }
  // Number("") and Number("  ") both coerce to 0, which would silently pass an isNaN check
  // and yield cycleNum: 0 — the same class of sentinel-pushed-downstream failure this parser
  // is meant to prevent. Require a finite positive integer.
  if (
    cycleNumRaw === undefined ||
    String(cycleNumRaw).trim().length === 0 ||
    !Number.isFinite(cycleNum) ||
    cycleNum <= 0
  ) {
    throw new Error(`Invalid ${CYCLE_NUM_KEY} value: ${String(cycleNumRaw)}`);
  }
  if (isNaN(cycleDate.getTime())) {
    throw new Error(`Invalid ${CYCLE_DATE_KEY} value: ${String(cycleDateRaw)}`);
  }
  if (sheetName.length === 0) {
    throw new Error(`Invalid ${SHEET_NAME_KEY} value: ${String(sheetNameRaw)}`);
  }
  if (!Object.values(Weekday).includes(cycleStartWeekday)) {
    throw new Error(
      `Invalid ${CYCLE_START_WEEKDAY_KEY} value: ${String(cycleStartWeekdayRaw)}`,
    );
  }

  return {
    program,
    cycleUnit,
    cycleNum,
    cycleDate,
    sheetName,
    cycleStartWeekday,
  };
}
