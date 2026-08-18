import { LIFT_RECORD_HEADER_MAP } from "@src/core/constants";
import { LiftRecord, SpreadsheetCell } from "@src/core/models";
import { parseDateStringUTC, toUTCMidnight } from "../jsUtil";
import { tableToObjects } from "./tableToObjects";

/**
 * Converts a 2D array to an array of LiftRecord objects.
 * @param {SpreadsheetCell[][]} data
 * @returns {LiftRecord[]}
 */

export function parseLiftRecords(data: SpreadsheetCell[][]): LiftRecord[] {
  const headerMap = LIFT_RECORD_HEADER_MAP;
  const rawObjects = tableToObjects(data, undefined);
  return rawObjects.map((obj) => {
    const result: Record<string, unknown> = {};
    for (const header in headerMap) {
      const { key, type } = headerMap[header]!;
      let value: unknown = obj[header];
      if (type === "number") {
        value = Number(value);
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
    return result as unknown as LiftRecord;
  });
}
