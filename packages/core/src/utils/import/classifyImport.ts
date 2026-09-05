import {
  ImportAlternative,
  ImportClassification,
  ImportKind,
} from '@lifting-logbook/types';
import { DEFAULT_SLOT_MAP } from '../../catalog/slotMaps';
import { SpreadsheetCell } from '../../models';
import { bucketConfidence, clearsAutoAccept } from './importThresholds';

/**
 * Signal-based CSV classifier for the Smart Import wizard (#477).
 *
 * Scores a parsed table against each of the four destinations using weighted,
 * fuzzy signals — header tokens (substring, not exact match), distinctive
 * markers, column-shape proximity, and lift-catalog hit rate — rather than
 * exact-header matching. This tolerates Strong-app exports, hand-typed sheets,
 * and RPT variants whose headers drift from the canonical templates.
 *
 * The winner's `type` is `null` unless its score clears the destination's
 * per-type auto-accept threshold; a low-confidence result is surfaced to the
 * user for a manual pick rather than auto-routed.
 */

/** A `<=` margin between the winner and a runner-up that flags a "close call". */
const CLOSE_CALL_DELTA = 0.15;

/**
 * Cap on the number of data rows sampled for classification. Classification
 * signals (header tokens, column shape, lift-catalog hit rate) are saturated
 * well before this; sampling bounds the `table.flat()` + per-column scan so a
 * large file under the byte cap isn't fully walked before the row-count limit
 * is enforced downstream in the parser.
 */
const CLASSIFY_SAMPLE_ROWS = 200;

interface KindProfile {
  kind: ImportKind;
  /** Headers (substring, normalized) that count toward this type. */
  signatureTokens: string[];
  /** Strong markers — their presence is a distinctive vote for this type. */
  distinctiveTokens: string[];
  /** Tokens whose presence argues *against* this type (e.g. workout/set vs training maxes). */
  antiTokens: string[];
  /** Approximate column count for the canonical layout. */
  expectedCols: number;
  /** Whether to score the lift-catalog hit rate of the lift column. */
  usesLiftColumn: boolean;
  /** Scan the first data column too (transposed layouts put attribute labels there). */
  transposed: boolean;
  /**
   * Scan every cell, not just headers/first-column. Used for the strength-goals
   * ladder, whose distinctive markers (Current TM / Intermediate / Advanced /
   * Elite / Goal Date) live in an interior header row and tier columns.
   */
  scanAllCells: boolean;
}

const PROFILES: readonly KindProfile[] = [
  {
    kind: 'lift-records',
    signatureTokens: ['program', 'cycle', 'workout', 'set', 'reps', 'weight', 'date', 'lift', 'notes'],
    distinctiveTokens: ['cycle', 'workout', 'set'],
    antiTokens: [],
    expectedCols: 9,
    usesLiftColumn: true,
    transposed: false,
    scanAllCells: false,
  },
  {
    kind: 'training-maxes',
    signatureTokens: ['date updated', 'date', 'lift', 'weight'],
    distinctiveTokens: ['date updated'],
    antiTokens: ['cycle', 'workout', 'set', 'program', 'amrap', 'warm-up'],
    expectedCols: 3,
    usesLiftColumn: true,
    transposed: false,
    scanAllCells: false,
  },
  {
    kind: 'program-spec',
    signatureTokens: [
      'week', 'offset', 'increment', 'order', 'sets', 'reps',
      'amrap', 'warm-up', 'decrement', 'activation', 'week type', 'lift',
    ],
    distinctiveTokens: ['warm-up', 'amrap', 'activation', 'decrement', 'week type'],
    antiTokens: [],
    expectedCols: 11,
    usesLiftColumn: false,
    transposed: false,
    scanAllCells: false,
  },
  {
    kind: 'strength-goals',
    signatureTokens: [
      'goal', 'target', 'ratio', 'current tm', 'intermediate', 'advanced', 'elite', 'lift', 'start date',
    ],
    distinctiveTokens: ['intermediate', 'advanced', 'elite', 'current tm', 'goal date'],
    antiTokens: ['cycle', 'workout', 'program'],
    expectedCols: 5,
    usesLiftColumn: false,
    transposed: true,
    scanAllCells: true,
  },
];

const norm = (cell: SpreadsheetCell | undefined): string =>
  String(cell ?? '').trim().toLowerCase();

/** Returns true if any normalized label contains the token as a substring. */
const hasToken = (labels: readonly string[], token: string): boolean =>
  labels.some((l) => l.includes(token));

interface KindScore {
  kind: ImportKind;
  score: number;
  reasons: string[];
}

function scoreKind(
  profile: KindProfile,
  ctx: {
    headers: string[];
    firstColumn: string[];
    /** Every normalized non-empty cell — a thunk, because only one profile wants it. */
    allCells: () => string[];
    numCols: number;
    liftHitRate: number;
  },
): KindScore {
  // Labels to scan: all cells for ladder layouts, headers + first column for
  // transposed ones, headers only otherwise.
  const labels = profile.scanAllCells
    ? ctx.allCells()
    : profile.transposed
      ? [...ctx.headers, ...ctx.firstColumn]
      : ctx.headers;

  const matchedSig = profile.signatureTokens.filter((t) => hasToken(labels, t));
  const tokenScore = profile.signatureTokens.length
    ? matchedSig.length / profile.signatureTokens.length
    : 0;

  const matchedDistinct = profile.distinctiveTokens.filter((t) => hasToken(labels, t));
  const distinctScore = profile.distinctiveTokens.length
    ? matchedDistinct.length / profile.distinctiveTokens.length
    : 0;

  const matchedAnti = profile.antiTokens.filter((t) => hasToken(ctx.headers, t));
  const antiPenalty = matchedAnti.length ? 0.5 : 0;

  // Shape: 1 when column count matches, decaying linearly with the gap.
  const shapeScore = Math.max(
    0,
    1 - Math.abs(ctx.numCols - profile.expectedCols) / profile.expectedCols,
  );

  // Weighted sum. Lift-using kinds reserve weight for catalog hit rate.
  let score: number;
  if (profile.usesLiftColumn) {
    score =
      0.4 * tokenScore + 0.2 * distinctScore + 0.15 * shapeScore + 0.25 * ctx.liftHitRate;
  } else {
    score = 0.5 * tokenScore + 0.3 * distinctScore + 0.2 * shapeScore;
  }
  score = Math.max(0, score - antiPenalty);

  const reasons: string[] = [];
  if (matchedSig.length) {
    reasons.push(
      `Matched ${matchedSig.length}/${profile.signatureTokens.length} expected columns (${matchedSig.join(', ')})`,
    );
  }
  if (matchedDistinct.length) {
    reasons.push(`Distinctive marker${matchedDistinct.length > 1 ? 's' : ''}: ${matchedDistinct.join(', ')}`);
  }
  if (profile.usesLiftColumn && ctx.liftHitRate > 0) {
    reasons.push(`${Math.round(ctx.liftHitRate * 100)}% of values matched known lifts`);
  }
  if (shapeScore > 0.6) {
    reasons.push(`${ctx.numCols} columns (≈${profile.expectedCols} expected)`);
  }
  if (matchedAnti.length) {
    reasons.push(`Penalized: unexpected columns for this type (${matchedAnti.join(', ')})`);
  }

  return { kind: profile.kind, score: Math.min(1, score), reasons };
}

/**
 * Best-effort hit rate of a table's most lift-like column against the slot map.
 *
 * Takes the already-normalized rows: every cell was normalized exactly once by
 * `classifyImport`, so this pass reads strings rather than re-running `norm`
 * per cell (issue #983).
 */
function liftColumnHitRate(headerCount: number, normRows: readonly string[][]): number {
  if (normRows.length === 0) return 0;
  // Prefer a column whose header looks like a lift column; else the column with
  // the most slot-map hits across the data rows.
  const slotKeys = new Set(Object.keys(DEFAULT_SLOT_MAP).map((k) => k.toLowerCase()));
  const colCount = Math.max(...normRows.map((r) => r.length), headerCount);

  let best = 0;
  for (let c = 0; c < colCount; c++) {
    let hits = 0;
    let nonEmpty = 0;
    for (const row of normRows) {
      const v = row[c] ?? '';
      if (!v) continue;
      nonEmpty++;
      if (slotKeys.has(v)) hits++;
    }
    if (nonEmpty > 0) best = Math.max(best, hits / nonEmpty);
  }
  return best;
}

export function classifyImport(table: SpreadsheetCell[][]): ImportClassification {
  const headerRow = table[0] ?? [];
  // Sample at most CLASSIFY_SAMPLE_ROWS data rows — enough to saturate every
  // signal without walking a large file end to end.
  const dataRows = table.slice(1, 1 + CLASSIFY_SAMPLE_ROWS);
  // Normalize the sample once; every signal below reads these strings rather
  // than re-normalizing the same cells (issue #983). `row.map(norm)` preserves
  // each row's length, so column positions are unchanged.
  const normHeader = headerRow.map(norm);
  const normRows = dataRows.map((r) => r.map(norm));
  const headers = normHeader.filter((h) => h.length > 0);
  const firstColumn = normRows.map((r) => r[0] ?? '').filter((v) => v.length > 0);
  const numCols = Math.max(headerRow.length, ...dataRows.map((r) => r.length), 0);
  const liftHitRate = liftColumnHitRate(headers.length, normRows);
  // Only the ladder profile scans every cell, so the flattened list is built on
  // first use rather than for every classification.
  let flattened: string[] | null = null;
  const allCells = (): string[] =>
    (flattened ??= [normHeader, ...normRows].flat().filter((v) => v.length > 0));

  const ctx = { headers, firstColumn, allCells, numCols, liftHitRate };
  const scored = PROFILES.map((p) => scoreKind(p, ctx)).sort((a, b) => b.score - a.score);

  const winner = scored[0]!;
  const cleared = winner.score > 0 && clearsAutoAccept(winner.kind, winner.score);

  const alternatives: ImportAlternative[] = scored.slice(1).map((s) => ({
    type: s.kind,
    confidence: Number(s.score.toFixed(4)),
    closeCall: winner.score - s.score <= CLOSE_CALL_DELTA,
  }));

  return {
    type: cleared ? winner.kind : null,
    confidence: Number(winner.score.toFixed(4)),
    bucket: bucketConfidence(winner.kind, winner.score),
    reasons: winner.reasons,
    alternatives,
  };
}
