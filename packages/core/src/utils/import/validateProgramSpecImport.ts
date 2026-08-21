import { ImportError, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import { LiftingProgramSpec } from '../../models';

export interface ProgramSpecImportValidationResult {
  valid: LiftingProgramSpec[];
  errors: ImportError[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && !isNaN(v);

/**
 * Validates parsed program-spec rows, collecting all errors. Row numbers are
 * 1-based and exclude the CSV header row.
 *
 * Rules: `week` ∈ {1,2,3}; `offset`, `increment`, `order`, `sets`, `reps`,
 * `wtDecrementPct` numeric; `lift` non-empty; `weekType` (when present) ∈
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
      rowErrors.push({ row, field: 'week', message: 'week must be 1, 2, or 3' });
    if (!isNum(r.offset)) rowErrors.push({ row, field: 'offset', message: 'offset is not a number' });
    if (!String(r.lift ?? '').trim())
      rowErrors.push({ row, field: IMPORT_ERROR_FIELD_LIFT, message: 'lift is empty' });
    if (!isNum(r.increment)) rowErrors.push({ row, field: 'increment', message: 'increment is not a number' });
    if (!isNum(r.order)) rowErrors.push({ row, field: 'order', message: 'order is not a number' });
    if (!isNum(r.sets)) rowErrors.push({ row, field: 'sets', message: 'sets is not a number' });
    if (!isNum(r.reps)) rowErrors.push({ row, field: 'reps', message: 'reps is not a number' });
    if (!isNum(r.wtDecrementPct))
      rowErrors.push({ row, field: 'wtDecrementPct', message: 'wtDecrementPct is not a number' });
    if (r.weekType !== undefined && !['training', 'test', 'deload'].includes(r.weekType))
      rowErrors.push({ row, field: 'weekType', message: `weekType must be 'training', 'test', or 'deload'` });

    if (rowErrors.length > 0) errors.push(...rowErrors);
    else valid.push(r);
  });

  return { valid, errors };
}
