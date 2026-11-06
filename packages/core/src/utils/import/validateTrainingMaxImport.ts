import { ImportError, ImportSpellingCollision, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import { liftIdFor } from '../../catalog/liftIdentity';
import { DEFAULT_SLOT_MAP } from '../../catalog/slotMaps';
import { TrainingMax } from '../../models';

/** A collision as validation finds it. The caller knows the lift's name, so adds the label. */
export type TrainingMaxSpellingCollision = Omit<ImportSpellingCollision, 'label'>;

export interface TrainingMaxImportValidationResult {
  /** Rows that passed validation, with lift names resolved to canonical IDs where known. */
  valid: TrainingMax[];
  errors: ImportError[];
  /** Valid rows that spell one lift differently (#1135). */
  spellingCollisions: TrainingMaxSpellingCollision[];
}

/**
 * Validates parsed training-max rows, collecting all errors (all-or-nothing
 * semantics mirroring {@link validateLiftImport}). Row numbers are 1-based and
 * exclude the CSV header row.
 *
 * Lift names are resolved through `DEFAULT_SLOT_MAP` when matched (so "Bench P."
 * → "bench-press"); unmatched names are kept verbatim rather than rejected,
 * since training maxes routinely cover lifts outside the built-in templates.
 */
export function validateTrainingMaxImport(
  maxes: TrainingMax[],
  slotMap: Readonly<Record<string, string>> = DEFAULT_SLOT_MAP,
): TrainingMaxImportValidationResult {
  const valid: TrainingMax[] = [];
  const errors: ImportError[] = [];
  const spellings: SpelledRow[] = [];

  maxes.forEach((m, i) => {
    const row = i + 1;
    const rowErrors: ImportError[] = [];

    const liftStr = String(m.lift ?? '').trim();
    if (!liftStr) rowErrors.push({ row, field: IMPORT_ERROR_FIELD_LIFT, code: 'LIFT_EMPTY', message: 'lift is empty' });
    if (typeof m.weight !== 'number' || isNaN(m.weight))
      rowErrors.push({ row, field: 'weight', code: 'WEIGHT_INVALID', message: 'Weight is not a number' });
    if (!m.dateUpdated || isNaN(m.dateUpdated.getTime()))
      rowErrors.push({ row, field: 'dateUpdated', code: 'DATE_INVALID', message: 'dateUpdated is invalid' });

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      // Object.prototype.hasOwnProperty.call, not a bare slotMap[liftStr] lookup:
      // slotMap is a plain object, and `?? liftStr` only catches null/undefined —
      // an inherited Object.prototype member (from a lift string of "toString",
      // "constructor", "__proto__", etc.) is neither, so it would otherwise
      // resolve to that inherited function/object instead of passing the name
      // through verbatim like any other unmatched name (issue #911 review).
      const resolved = Object.prototype.hasOwnProperty.call(slotMap, liftStr)
        ? slotMap[liftStr]!
        : liftStr;
      const row = { ...m, lift: resolved as TrainingMax['lift'] };
      valid.push(row);
      spellings.push({ spelling: liftStr, row });
    }
  });

  return { valid, errors, spellingCollisions: spellingCollisionsOf(spellings) };
}

interface SpelledRow {
  /** The lift as the file wrote it, which resolving loses. */
  spelling: string;
  row: TrainingMax;
}

/**
 * The rows that resolve to one lift while spelling it differently (#1135).
 *
 * Rows sharing a spelling aren't a collision. Two spellings can store under one key, so only
 * the newest stores (`OH Press`, `OH Press-HV`), or under two, since the slot map leaves a
 * display name as written (`Squat` stores as `back-squat`, `Back Squat` as itself). Either
 * way a reader takes one max for the lift, so both are reported.
 *
 * Each spelling appears at its newest row. They order most recent first, ties by that row's
 * place in the file, which is how `latestTrainingMaxFirst` picks the one stored under a
 * shared key.
 */
function spellingCollisionsOf(rows: readonly SpelledRow[]): TrainingMaxSpellingCollision[] {
  const newestBySpelling = new Map<string, Map<string, { row: TrainingMax; index: number }>>();
  rows.forEach(({ spelling, row }, index) => {
    const id = liftIdFor(row.lift);
    const spellings = newestBySpelling.get(id) ?? new Map<string, { row: TrainingMax; index: number }>();
    newestBySpelling.set(id, spellings);
    const newest = spellings.get(spelling);
    if (!newest || row.dateUpdated.getTime() > newest.row.dateUpdated.getTime()) {
      spellings.set(spelling, { row, index });
    }
  });

  return [...newestBySpelling.entries()]
    .filter(([, spellings]) => spellings.size > 1)
    .map(([key, spellings]) => ({
      key,
      rows: [...spellings.entries()]
        .sort(([, a], [, b]) => b.row.dateUpdated.getTime() - a.row.dateUpdated.getTime() || a.index - b.index)
        .map(([spelling, { row }]) => ({
          spelling,
          lift: row.lift,
          weight: row.weight,
          dateUpdated: row.dateUpdated.toISOString().slice(0, 10),
        })),
    }));
}
