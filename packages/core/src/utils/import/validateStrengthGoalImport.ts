import { ImportError, ImportGoalSpellingCollision, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import { liftIdFor } from '../../catalog/liftIdentity';
import { DEFAULT_SLOT_MAP } from '../../catalog/slotMaps';
import { StrengthGoalEntry } from '../../models';
import { goalValue } from './buildImportPreview';

/** A collision as validation finds it. The caller knows the lift's name, so adds the label. */
export type StrengthGoalSpellingCollision = Omit<ImportGoalSpellingCollision, 'label'>;

export interface StrengthGoalImportValidationResult {
  valid: StrengthGoalEntry[];
  errors: ImportError[];
  /** Valid rows that spell one lift differently (#1169). */
  goalSpellingCollisions: StrengthGoalSpellingCollision[];
}

/**
 * Validates parsed strength-goal entries, collecting all errors. Row numbers are
 * 1-based and exclude the CSV header row.
 *
 * Rules: `lift` non-empty; `goalType` ∈ {absolute, relative}; absolute goals
 * require a numeric `target`, relative goals require a numeric `ratio`; `unit` ∈
 * {lbs, kg}. Lift names are resolved through `DEFAULT_SLOT_MAP` when matched and
 * kept verbatim otherwise (goals may target lifts outside the built-in templates).
 */
export function validateStrengthGoalImport(
  goals: StrengthGoalEntry[],
  slotMap: Readonly<Record<string, string>> = DEFAULT_SLOT_MAP,
): StrengthGoalImportValidationResult {
  const valid: StrengthGoalEntry[] = [];
  const errors: ImportError[] = [];
  const spellings: SpelledGoal[] = [];

  goals.forEach((g, i) => {
    const row = i + 1;
    const rowErrors: ImportError[] = [];

    const liftStr = String(g.lift ?? '').trim();
    if (!liftStr) rowErrors.push({ row, field: IMPORT_ERROR_FIELD_LIFT, code: 'LIFT_EMPTY', message: 'lift is empty' });

    if (g.goalType !== 'absolute' && g.goalType !== 'relative') {
      rowErrors.push({ row, field: 'goalType', code: 'GOAL_TYPE_INVALID', message: `goalType must be 'absolute' or 'relative'` });
    } else if (g.goalType === 'absolute' && (typeof g.target !== 'number' || isNaN(g.target))) {
      rowErrors.push({ row, field: 'target', code: 'TARGET_INVALID', message: 'absolute goal requires a numeric target' });
    } else if (g.goalType === 'relative' && (typeof g.ratio !== 'number' || isNaN(g.ratio))) {
      rowErrors.push({ row, field: 'ratio', code: 'RATIO_INVALID', message: 'relative goal requires a numeric ratio' });
    }

    if (g.unit !== 'lbs' && g.unit !== 'kg') {
      rowErrors.push({ row, field: 'unit', code: 'UNIT_INVALID', message: `unit must be 'lbs' or 'kg'` });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      // Object.prototype.hasOwnProperty.call — see validateTrainingMaxImport.ts
      // for why a bare `slotMap[liftStr] ?? liftStr` lookup is unsafe here.
      const resolved = Object.prototype.hasOwnProperty.call(slotMap, liftStr)
        ? slotMap[liftStr]!
        : liftStr;
      const goal = { ...g, lift: resolved };
      valid.push(goal);
      spellings.push({ spelling: liftStr, rowIndex: row, goal });
    }
  });

  return { valid, errors, goalSpellingCollisions: goalSpellingCollisionsOf(spellings) };
}

interface SpelledGoal {
  /** The lift as the file wrote it, which resolving loses. */
  spelling: string;
  rowIndex: number;
  goal: StrengthGoalEntry;
}

/**
 * The rows that resolve to one lift while spelling it differently (#1169).
 *
 * Rows sharing a spelling aren't a collision. Two spellings can store under one key, so only
 * the first stores (`OH Press`, `OH Press-HV`), or under two, since the slot map leaves a
 * display name as written (`Squat` stores as `back-squat`, `Back Squat` as itself). Either
 * way a reader takes one goal for the lift, so both are reported.
 *
 * Goals upsert first-row-wins, so each spelling shows its first row, and they list in file
 * order. `rowIndexes` covers a spelling's other rows too: keeping only its first would let a
 * later row of that spelling take its place under the lift the user just moved it away from.
 */
function goalSpellingCollisionsOf(rows: readonly SpelledGoal[]): StrengthGoalSpellingCollision[] {
  const bySpelling = new Map<string, Map<string, StrengthGoalSpellingCollision['rows'][number]>>();
  for (const { spelling, rowIndex, goal } of rows) {
    const id = liftIdFor(goal.lift);
    const spellings = bySpelling.get(id) ?? new Map<string, StrengthGoalSpellingCollision['rows'][number]>();
    bySpelling.set(id, spellings);
    const seen = spellings.get(spelling);
    if (seen) seen.rowIndexes.push(rowIndex);
    else spellings.set(spelling, { spelling, lift: goal.lift, value: goalValue(goal), rowIndexes: [rowIndex] });
  }

  return [...bySpelling.entries()]
    .filter(([, spellings]) => spellings.size > 1)
    .map(([key, spellings]) => ({ key, rows: [...spellings.values()] }));
}
