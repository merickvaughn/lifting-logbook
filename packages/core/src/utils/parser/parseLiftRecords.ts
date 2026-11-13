import {
  LEGACY_LIFT_RECORD_HEADERS,
  LIFT_RECORD_HEADER_MAP,
} from "@src/core/constants";
import { LiftRecord, SpreadsheetCell } from "@src/core/models";
import { parseDateStringUTC, toUTCMidnight } from "../jsUtil";
import { tableToObjects } from "./tableToObjects";

/** A field the Assign step reads as "the file doesn't say" when its cell is blank (#1253). */
export type AssignBlankField = "macrocycleNum" | "workoutNum" | "date";

/**
 * A parsed lift record. With `assign`, `blankFields` names the fields whose cell was blank or
 * whose column is missing, so a validator can tell them from a cell it couldn't read: both
 * parse to `NaN` or an invalid date, but only a blank one is left to the Assign step.
 */
export type ParsedLiftRecord = LiftRecord & { blankFields?: readonly AssignBlankField[] };

const ASSIGN_BLANK_FIELDS: ReadonlySet<string> = new Set<AssignBlankField>(["macrocycleNum", "workoutNum", "date"]);

/**
 * Converts a 2D array to an array of LiftRecord objects.
 *
 * With `assign`, a blank `Macrocycle #` or `Workout #` cell reads as `NaN`, the same as a
 * missing column, rather than `Number("")`'s 0: the Assign step reads either as "the file
 * doesn't say" (#1253), while 0 is a number a file can really use. Those fields and a blank
 * date are named in `blankFields`.
 * @param {SpreadsheetCell[][]} data
 * @returns {ParsedLiftRecord[]}
 */

export function parseLiftRecords(
  data: SpreadsheetCell[][],
  options: { assign?: boolean } = {},
): ParsedLiftRecord[] {
  const headerMap = LIFT_RECORD_HEADER_MAP;
  const rawObjects = tableToObjects(data, undefined);
  return rawObjects.map((obj) => {
    const result: Record<string, unknown> = {};
    const blankFields: AssignBlankField[] = [];
    for (const header in headerMap) {
      const { key, type } = headerMap[header]!;
      // The canonical header wins; otherwise the first accepted alternate present.
      let value: unknown = obj[header];
      for (const alternate of LEGACY_LIFT_RECORD_HEADERS[header] ?? []) {
        if (value !== undefined) break;
        value = obj[alternate];
      }
      const blank = value === undefined || value === null || String(value).trim() === "";
      const assignBlank = options.assign === true && blank && ASSIGN_BLANK_FIELDS.has(key);
      if (assignBlank) blankFields.push(key as AssignBlankField);
      if (type === "number") {
        value = assignBlank ? NaN : Number(value);
      }
      if (key === "date") {
        // Non-ISO date strings (the common case here -- CSV cells like
        // "12/16/2025") parse at LOCAL midnight, not UTC midnight (ECMA-262),
        // which lands on the WRONG UTC calendar day on any host ahead of UTC
        // (issue #894) -- toUTCMidnight alone only fixes the time-of-day
        // component, not which day it truncates to. parseDateStringUTC parses
        // the string as UTC explicitly, so the calendar day always matches
        // what the cell says regardless of host timezone; toUTCMidnight
        // remains as belt-and-suspenders for any input shape it falls back to
        // `new Date(value)` for. The natural key / public id /
        // SkippedRecord.naturalKey all encode this date as a UTC calendar day
        // and reconstruct UTC midnight when parsing a key back apart, so
        // normalizing here keeps every ingest path agreeing on the same
        // calendar day regardless of the parsing host's timezone (issue #884).
        value = toUTCMidnight(parseDateStringUTC(String(value ?? "")));
      }
      result[key] = value;
    }
    if (blankFields.length > 0) result.blankFields = blankFields;
    return result as unknown as ParsedLiftRecord;
  });
}
