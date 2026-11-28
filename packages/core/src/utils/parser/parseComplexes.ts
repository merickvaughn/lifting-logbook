import { COMPLEX_HEADER_MAP } from "@src/core/constants";
import { SpreadsheetCell } from "@src/core/models";
import { unescapeCsvFormula } from "../export/serializeExportCsv";
import { tableToObjects } from "./tableToObjects";

/** One row of `complexes.csv` (#1514): a component of the complex it names. */
export interface ComplexImportRow {
  complex: string;
  /** The component's 1-based position in the complex. */
  component: number;
  lift: string;
  reps: number;
}

/**
 * Reads `complexes.csv` rows. Numbers that don't read as numbers are NaN, and text cells lose the
 * apostrophe the export put in front of a formula character, for `validateComplexImport` to judge.
 */
export function parseComplexes(data: SpreadsheetCell[][]): ComplexImportRow[] {
  return tableToObjects(data, undefined).map((obj) => {
    const result: Record<string, unknown> = {};
    for (const [header, { key, type }] of Object.entries(COMPLEX_HEADER_MAP)) {
      const value = obj[header];
      result[key] =
        type === "number"
          ? String(value ?? "").trim() === ""
            ? NaN
            : Number(value)
          : unescapeCsvFormula(String(value ?? "").trim());
    }
    return result as unknown as ComplexImportRow;
  });
}
