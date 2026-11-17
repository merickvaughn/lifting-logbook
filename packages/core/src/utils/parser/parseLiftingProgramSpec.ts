import { WeekType } from "@lifting-logbook/types";
import { LIFTING_PROGRAM_SPEC_HEADER_MAP } from "@src/core/constants";
import { LiftingProgramSpec, SpreadsheetCell } from "@src/core/models";
import { tableToObjects } from "./tableToObjects";

/**
 * Converts a 2D array to an array of LiftingProgramSpec objects.
 * @param {SpreadsheetCell[][]} data
 * @returns {LiftingProgramSpec[]}
 */

export function parseLiftingProgramSpec(data: SpreadsheetCell[][]): LiftingProgramSpec[] {
  // Use header map from constants
  const headerMap = LIFTING_PROGRAM_SPEC_HEADER_MAP;
  // Convert using tableToObjects, then cast/convert types
  const rawObjects = tableToObjects(data, undefined);
  // RPT repeats a one-week block, so its spec has no Week column: every row is week 1.
  const hasWeekColumn = (data[0] ?? []).some((h) => String(h) === "Week");
  const parsed = rawObjects.map((obj) => {
    const result: Record<string, unknown> = {};
    for (const header in headerMap) {
      const { key, type } = headerMap[header]!;
      let value: unknown = obj[header];
      if (key === "week" && !hasWeekColumn) value = 1;
      if (type === "number") {
        value = Number(value);
      } else if (type === "boolean|string") {
        if (value === "TRUE" || value === true) value = true;
        else if (value === "FALSE" || value === false) value = false;
        // else leave as string
      }
      result[key] = value;
    }
    return result as unknown as LiftingProgramSpec;
  });

  // Apply week-level weekType inheritance: blank rows inherit the first non-blank
  // value in the same week; an all-blank week defaults to 'training'.
  const isBlank = (v: WeekType | undefined): boolean => !v || (v as string) === '';
  const weekGroups = new Map<number, typeof parsed>();
  for (const row of parsed) {
    const grp = weekGroups.get(row.week) ?? [];
    grp.push(row);
    weekGroups.set(row.week, grp);
  }
  for (const rows of weekGroups.values()) {
    const firstNonBlank = rows.find((r) => !isBlank(r.weekType))?.weekType ?? 'training';
    for (const r of rows) {
      if (isBlank(r.weekType)) r.weekType = firstNonBlank as WeekType;
    }
  }

  // Sort by offset, then order
  parsed.sort((a, b) => {
    if (a.offset !== b.offset) {
      return a.offset - b.offset;
    }
    return (a.order ?? 0) - (b.order ?? 0);
  });

  return parsed;
}
