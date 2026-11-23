import { WeekType } from "@lifting-logbook/types";
import { LIFTING_PROGRAM_SPEC_HEADER_MAP } from "@src/core/constants";
import { LiftingProgramSpec, SpreadsheetCell } from "@src/core/models";
import { unescapeCsvFormula } from "../export/serializeExportCsv";
import { tableToObjects } from "./tableToObjects";

/**
 * Reads a `Weight %` list (each set's weight as a share of the top set) as the single
 * decrement it implies. `1,.95,.9` is 0.05. NaN when the steps aren't even (or the list
 * isn't numbers), since one decrement can't represent it. A one-set list has no step: 0.
 */
function decrementFromWeightPct(raw: unknown): number {
  const pcts = String(raw ?? "").split(",").map((p) => Number(p.trim()));
  if (pcts.some((p) => isNaN(p))) return NaN;
  if (pcts.length < 2) return 0;
  const step = (pcts[0]! - pcts[pcts.length - 1]!) / (pcts.length - 1);
  const even = pcts.every((p, i) => Math.abs(pcts[0]! - i * step - p) < 1e-9);
  return even ? Math.round(step * 1e6) / 1e6 : NaN;
}

/** The text fields the export escapes (#1342). */
const ESCAPED_FIELDS: ReadonlySet<string> = new Set(["lift", "warmUpPct", "activation", "weekType"]);

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
  // A one-week program repeats a single block, so its sheet has no Week column: every row is week 1.
  const hasWeekColumn = (data[0] ?? []).some((h) => String(h) === "Week");
  const headers = (data[0] ?? []).map((h) => String(h));
  const useWeightPct = !headers.includes("WT Decrement %") && headers.includes("Weight %");
  const parsed = rawObjects.map((obj) => {
    const result: Record<string, unknown> = {};
    for (const header in headerMap) {
      const { key, type } = headerMap[header]!;
      // `Weight %` is in the header map so the column mapper and `applyColumnOverrides`
      // know it (#1401), but only the `useWeightPct` branch below may populate it: a
      // sheet carrying both columns keeps `WT Decrement %` as its decrement, and an
      // always-set `weightPct` would re-point that column's validation error at
      // `weightPct` (validateProgramSpecImport).
      if (key === "weightPct") continue;
      let value: unknown = key === "week" && !hasWeekColumn ? 1 : obj[header];
      if (type === "number") {
        value = Number(value);
      } else if (type === "boolean|string") {
        if (value === "TRUE" || value === true) value = true;
        else if (value === "FALSE" || value === false) value = false;
        // else leave as string
      }
      if (ESCAPED_FIELDS.has(key) && typeof value === "string") value = unescapeCsvFormula(value);
      result[key] = value;
    }
    if (useWeightPct) {
      result.weightPct = String(obj["Weight %"] ?? "");
      result.wtDecrementPct = decrementFromWeightPct(obj["Weight %"]);
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
