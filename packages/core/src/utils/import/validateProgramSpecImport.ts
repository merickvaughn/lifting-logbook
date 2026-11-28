import { ImportError, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import { LiftingProgramSpec } from '../../models';
import { integerColumnError } from './validateLiftImport';

export interface ProgramSpecImportValidationResult {
  valid: LiftingProgramSpec[];
  errors: ImportError[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && !isNaN(v);

/** The numeric fields stored in integer columns. `week` is checked against 1 to 3 instead. */
const INTEGER_FIELDS = [
  ['offset', 'OFFSET_INVALID', 'Offset'],
  ['order', 'ORDER_INVALID', 'Order'],
  ['sets', 'SETS_INVALID', 'Sets'],
  ['reps', 'REPS_INVALID', 'Reps'],
] as const satisfies ReadonlyArray<readonly [keyof LiftingProgramSpec, ImportError['code'], string]>;

/**
 * Validates parsed program-spec rows, collecting all errors. Row numbers are
 * 1-based and exclude the CSV header row.
 *
 * Rules: `week` ∈ {1,2,3}; `offset`, `increment`, `order`, `sets`, `reps`,
 * `wtDecrementPct` numeric, and `offset`, `order`, `sets`, `reps` whole numbers an integer
 * column holds; `lift` non-empty; `weekType` (when present) ∈
 * {training, test, deload}.
 */
export function validateProgramSpecImport(
  rows: LiftingProgramSpec[],
): ProgramSpecImportValidationResult {
  const valid: LiftingProgramSpec[] = [];
  const errors: ImportError[] = [];

  rows.forEach((r, i) => {
    const row = i + 1;
    const rowErrors: ImportError[] = [];

    if (r.week !== 1 && r.week !== 2 && r.week !== 3)
      rowErrors.push({ row, field: 'week', code: 'WEEK_INVALID', message: 'Week must be 1, 2, or 3' });
    if (!isNum(r.offset)) rowErrors.push({ row, field: 'offset', code: 'OFFSET_INVALID', message: 'Offset is not a number' });
    if (!String(r.lift ?? '').trim())
      rowErrors.push({ row, field: IMPORT_ERROR_FIELD_LIFT, code: 'LIFT_EMPTY', message: 'lift is empty' });
    if (!isNum(r.increment)) rowErrors.push({ row, field: 'increment', code: 'INCREMENT_INVALID', message: 'Increment is not a number' });
    if (!isNum(r.order)) rowErrors.push({ row, field: 'order', code: 'ORDER_INVALID', message: 'Order is not a number' });
    if (!isNum(r.sets)) rowErrors.push({ row, field: 'sets', code: 'SETS_INVALID', message: 'Sets is not a number' });
    if (!isNum(r.reps)) rowErrors.push({ row, field: 'reps', code: 'REPS_INVALID', message: 'Reps is not a number' });
    // Offset, Order, Sets and Reps are integer columns (#1160). A non-number already failed above.
    for (const [field, code, label] of INTEGER_FIELDS) {
      const value = r[field];
      const error = isNum(value) ? integerColumnError(row, field, code, label, value) : null;
      if (error) rowErrors.push(error);
    }
    if (!isNum(r.wtDecrementPct) && r.weightPct !== undefined)
      rowErrors.push({
        row,
        field: 'weightPct',
        code: 'WT_DECREMENT_PCT_INVALID',
        message: `Weight % "${r.weightPct}" must step evenly (like 1,.95,.9) to be read as one decrement`,
      });
    else if (!isNum(r.wtDecrementPct))
      rowErrors.push({ row, field: 'wtDecrementPct', code: 'WT_DECREMENT_PCT_INVALID', message: 'WT Decrement % is not a number' });
    if (r.loadPct != null && !(isNum(r.loadPct) && r.loadPct > 0 && r.loadPct <= 1))
      rowErrors.push({ row, field: 'loadPct', code: 'LOAD_PCT_INVALID', message: 'Load % must be above 0 and at most 1 (or 100%), or blank' });
    if (r.weekType !== undefined && !['training', 'test', 'deload'].includes(r.weekType))
      rowErrors.push({ row, field: 'weekType', code: 'WEEK_TYPE_INVALID', message: 'Week Type must be training, test, or deload' });

    if (rowErrors.length > 0) errors.push(...rowErrors);
    else valid.push(r);
  });

  return { valid, errors };
}
