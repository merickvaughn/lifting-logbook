import { ImportKind } from '@lifting-logbook/types';
import { SpreadsheetCell } from '../../models';
import {
  COMPLEX_HEADER_MAP,
  LIFT_RECORD_HEADER_MAP,
  LIFTING_PROGRAM_SPEC_HEADER_MAP,
  TRAINING_MAX_HEADER_MAP,
} from '../../constants/schema';

/**
 * Per-destination map from field key → canonical CSV header.
 * Built by inverting the parser header maps.
 *
 * Strength-goals uses a transposed layout (no simple header row) so it is
 * excluded — passing `strength-goals` as destination is a no-op.
 */
const DESTINATION_KEY_TO_HEADER: Partial<Record<ImportKind, Map<string, string>>> = {
  'lift-records': invertHeaderMap(LIFT_RECORD_HEADER_MAP),
  'training-maxes': invertHeaderMap(TRAINING_MAX_HEADER_MAP),
  'program-spec': invertHeaderMap(LIFTING_PROGRAM_SPEC_HEADER_MAP),
  'complexes': invertHeaderMap(COMPLEX_HEADER_MAP),
};

function invertHeaderMap(map: Record<string, { key: string }>): Map<string, string> {
  const inv = new Map<string, string>();
  for (const [header, { key }] of Object.entries(map)) {
    inv.set(key, header);
  }
  return inv;
}

/**
 * Apply user-supplied column overrides to a CSV table (in-place clone of row 0).
 *
 * `overrides` maps a **source CSV header** (as it appears in the uploaded file)
 * to a **destination field key** (e.g. `"lift"`, `"weight"`). This function
 * renames matching cells in row 0 to the canonical CSV header that the
 * destination's parser expects, so the parser sees a standard header row even
 * when the uploaded file uses non-standard column names.
 *
 * Returns a new table reference only when row 0 is modified; returns the
 * original table unchanged otherwise.
 */
export function applyColumnOverrides(
  table: SpreadsheetCell[][],
  overrides: Record<string, string>,
  destination: ImportKind,
): SpreadsheetCell[][] {
  const keyToHeader = DESTINATION_KEY_TO_HEADER[destination];
  if (!keyToHeader || Object.keys(overrides).length === 0) return table;

  const headerRow = table[0];
  if (!headerRow) return table;

  // Build: sourceHeader → canonicalHeader, skipping unknown field keys.
  const renames = new Map<string, string>();
  for (const [sourceHeader, fieldKey] of Object.entries(overrides)) {
    const canonical = keyToHeader.get(fieldKey);
    if (canonical && canonical !== sourceHeader) {
      renames.set(sourceHeader, canonical);
    }
  }
  if (renames.size === 0) return table;

  const newHeader: SpreadsheetCell[] = headerRow.map((cell) => {
    const s = String(cell ?? '');
    return renames.has(s) ? renames.get(s)! : cell;
  });

  return [newHeader, ...table.slice(1)];
}
