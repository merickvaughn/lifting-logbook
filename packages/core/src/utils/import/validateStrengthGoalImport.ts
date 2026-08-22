import { ImportError, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import { DEFAULT_SLOT_MAP } from '../../catalog/slotMaps';
import { StrengthGoalEntry } from '../../models';

export interface StrengthGoalImportValidationResult {
  valid: StrengthGoalEntry[];
  errors: ImportError[];
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

  goals.forEach((g, i) => {
    const row = i + 1;
    const rowErrors: ImportError[] = [];

    const liftStr = String(g.lift ?? '').trim();
    if (!liftStr) rowErrors.push({ row, field: IMPORT_ERROR_FIELD_LIFT, message: 'lift is empty' });

    if (g.goalType !== 'absolute' && g.goalType !== 'relative') {
      rowErrors.push({ row, field: 'goalType', message: `goalType must be 'absolute' or 'relative'` });
    } else if (g.goalType === 'absolute' && (typeof g.target !== 'number' || isNaN(g.target))) {
      rowErrors.push({ row, field: 'target', message: 'absolute goal requires a numeric target' });
    } else if (g.goalType === 'relative' && (typeof g.ratio !== 'number' || isNaN(g.ratio))) {
      rowErrors.push({ row, field: 'ratio', message: 'relative goal requires a numeric ratio' });
    }

    if (g.unit !== 'lbs' && g.unit !== 'kg') {
      rowErrors.push({ row, field: 'unit', message: `unit must be 'lbs' or 'kg'` });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      // Object.prototype.hasOwnProperty.call — see validateTrainingMaxImport.ts
      // for why a bare `slotMap[liftStr] ?? liftStr` lookup is unsafe here.
      const resolved = Object.prototype.hasOwnProperty.call(slotMap, liftStr)
        ? slotMap[liftStr]!
        : liftStr;
      valid.push({ ...g, lift: resolved });
    }
  });

  return { valid, errors };
}
