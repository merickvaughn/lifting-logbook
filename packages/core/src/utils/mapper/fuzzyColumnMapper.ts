import { SpreadsheetCell } from '../../models';
import {
  LEGACY_LIFT_RECORD_HEADERS,
  LIFT_RECORD_HEADER_MAP,
  TRAINING_MAX_HEADER_MAP,
  LIFTING_PROGRAM_SPEC_HEADER_MAP,
} from '../../constants';
import { ImportKind } from '@lifting-logbook/types';

/**
 * A single column mapping with confidence score and transformation notes.
 * Returned by fuzzyColumnMapper to guide the frontend UI.
 */
export interface ColumnMapping {
  /** Original CSV column header from the uploaded file. */
  sourceHeader: string;
  /** Canonical destination field name (e.g., "lift", "weight", "date"). */
  destinationField: string;
  /** Confidence score (0–1) that this mapping is correct. */
  confidence: number;
  /** True if this field must be mapped before progression. */
  required: boolean;
  /** Transformation description (e.g., "Split 'Weight x Reps' into fields"). */
  transformationNote?: string;
  /** Up to 2 alternative field matches with lower confidence. */
  alternatives?: Array<{
    field: string;
    confidence: number;
  }>;
}

/**
 * Normalize a string for comparison: lowercase, trim, single spaces.
 */
function normalize(s: SpreadsheetCell | string | undefined): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Returns true if every character in `abbr` appears in `full` in order.
 * Used to catch abbreviations like "Wt" → "weight", "Prog" → "program".
 */
function isSubsequence(abbr: string, full: string): boolean {
  let ai = 0;
  for (let fi = 0; fi < full.length && ai < abbr.length; fi++) {
    if (full[fi] === abbr[ai]) ai++;
  }
  return ai === abbr.length;
}

/**
 * Calculate similarity between a source header and a canonical display-name.
 * Returns a score 0–1 where 1.0 is a perfect match.
 *
 * Scoring tiers (highest wins):
 *   1. Exact normalized match → 1.0
 *   2. Token-level intersection (handles multi-word labels like "Date Updated") → 0.5–1.0
 *   3. Prefix match (source is a prefix of canonical or vice versa) → 0.7
 *   4. Subsequence match (abbreviations like "Wt" → "weight") → 0.4–0.65
 *   5. No match → 0
 */
function calculateSimilarity(sourceHeader: string, canonicalField: string): number {
  if (!sourceHeader || !canonicalField) return 0;

  const tokenize = (s: string): string[] =>
    s.split(/[\s\-\.()#?%]+/).filter((t) => t.length > 0);

  // Tier 1: exact normalized match
  if (sourceHeader === canonicalField) return 1.0;

  const sourceTokens = tokenize(sourceHeader);
  const fieldTokens = tokenize(canonicalField);

  if (sourceTokens.length === 0 || fieldTokens.length === 0) return 0;

  // Tier 2: token intersection — a match if tokens from source appear in field or vice-versa
  const tokenMatches = sourceTokens.filter((t) =>
    fieldTokens.some((ft) => ft.includes(t) || t.includes(ft))
  ).length;
  const tokenScore = tokenMatches / Math.max(sourceTokens.length, fieldTokens.length);
  if (tokenScore > 0) return Math.min(1, tokenScore);

  // Tier 3: prefix match — handles "Prog" → "program" or "date" → "date updated"
  const src = sourceHeader;
  const fld = canonicalField;
  if (fld.startsWith(src) || src.startsWith(fld)) {
    return 0.7 * (Math.min(src.length, fld.length) / Math.max(src.length, fld.length));
  }

  // Tier 4: subsequence — handles common abbreviations like "Wt" → "weight"
  // Only fire when source is shorter than canonical (it's an abbreviation, not a superset).
  // Score reflects character density: shorter canonical = more specific match.
  // e.g. "wt"/"weight"(6) → 0.3 + (2/6)*0.4 = 0.43, "wt"/"workout #"(9) → 0.3 + (2/9)*0.4 = 0.39
  if (src.length < fld.length && isSubsequence(src, fld)) {
    const ratio = src.length / fld.length;
    return 0.3 + ratio * 0.4;
  }

  return 0;
}

/**
 * Get the list of required fields for a given import kind.
 */
function getRequiredFields(kind: ImportKind): Set<string> {
  const required = new Map<ImportKind, Set<string>>([
    ['lift-records', new Set(['program', 'macrocycleNum', 'workoutNum', 'date', 'lift', 'setNum', 'weight', 'reps'])],
    ['training-maxes', new Set(['lift', 'weight', 'dateUpdated'])],
    ['program-spec', new Set(['week', 'offset', 'lift', 'increment', 'order', 'sets', 'reps', 'wtDecrementPct'])],
    // Strength goals requires lift, goalType, unit, and either target or ratio
    // For now, mark lift, goalType, unit as required (target/ratio checked per-row)
    ['strength-goals', new Set<string>()],
  ]);

  return required.get(kind) ?? new Set();
}

/**
 * Get the canonical header map for a given import kind.
 */
function getHeaderMapForKind(kind: ImportKind): Record<string, { key: string; type: string }> {
  switch (kind) {
    case 'lift-records':
      return LIFT_RECORD_HEADER_MAP;
    case 'training-maxes':
      return TRAINING_MAX_HEADER_MAP;
    case 'program-spec':
      return LIFTING_PROGRAM_SPEC_HEADER_MAP;
    default:
      return {};
  }
}

/**
 * Other header spellings accepted for each canonical header of a kind. A source
 * header is scored against these as well as the canonical name, so an alternate
 * maps on an exact match rather than by token coincidence.
 */
function getAlternateHeadersForKind(kind: ImportKind): Readonly<Record<string, readonly string[]>> {
  return kind === 'lift-records' ? LEGACY_LIFT_RECORD_HEADERS : {};
}

/**
 * Fuzzy-map a list of source CSV headers to canonical destination fields.
 *
 * For each source header, finds the best-matching destination field with a
 * confidence score. Returns mappings for all source headers plus unmapped
 * required destination fields.
 *
 * strength-goals uses a tier-ladder format parsed server-side (Lift / Current TM
 * / tier columns); per-column mapping is not applicable and returns [].
 *
 * @param sourceHeaders - First row of the CSV (column headers)
 * @param kind - Import destination type (lift-records, training-maxes, etc.)
 * @returns Array of column mappings with confidence scores, or [] when mapping is N/A
 */
export function fuzzyColumnMapper(sourceHeaders: SpreadsheetCell[], kind: ImportKind): ColumnMapping[] {
  if (kind === 'strength-goals') return [];
  const headerMap = getHeaderMapForKind(kind);
  const alternateHeaders = getAlternateHeadersForKind(kind);
  const requiredFields = getRequiredFields(kind);
  const mappings: ColumnMapping[] = [];

  // Normalize source headers
  const normalizedSources = sourceHeaders.map(normalize);

  // For each source header, find the best matching destination field
  const mappedDestinationFields = new Set<string>();

  normalizedSources.forEach((sourceHeader, i) => {
    if (!sourceHeader) return; // Skip empty headers

    const sourceHeaderDisplay = String(sourceHeaders[i] ?? '').trim();
    const scores: Array<{ key: string; field: string; score: number }> = [];

    // Score against each canonical field
    Object.entries(headerMap).forEach(([displayName, { key }]) => {
      const score = Math.max(
        ...[displayName, ...(alternateHeaders[displayName] ?? [])].map((name) =>
          calculateSimilarity(sourceHeader, normalize(name)),
        ),
      );
      scores.push({ key, field: displayName, score });
    });

    // Sort by score and pick top match
    scores.sort((a, b) => b.score - a.score);
    const bestMatch = scores[0];

    if (bestMatch && bestMatch.score > 0) {
      mappedDestinationFields.add(bestMatch.key);
      mappings.push({
        sourceHeader: sourceHeaderDisplay,
        destinationField: bestMatch.key,
        confidence: bestMatch.score,
        required: requiredFields.has(bestMatch.key),
        alternatives: scores
          .slice(1, 3)
          .filter((s) => s.score > 0.3)
          .map((s) => ({
            field: s.key,
            confidence: Math.round(s.score * 100) / 100,
          })),
      });
    } else {
      // No matching destination field
      mappings.push({
        sourceHeader: sourceHeaderDisplay,
        destinationField: '',
        confidence: 0,
        required: false,
        transformationNote: 'No matching field found',
      });
    }
  });

  // Add unmapped required destination fields
  requiredFields.forEach((fieldKey) => {
    if (!mappedDestinationFields.has(fieldKey)) {
      mappings.push({
        sourceHeader: '',
        destinationField: fieldKey,
        confidence: 0,
        required: true,
        transformationNote: `Required field not found in CSV`,
      });
    }
  });

  return mappings;
}
