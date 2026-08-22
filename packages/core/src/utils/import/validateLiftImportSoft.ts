import { ImportError } from '@lifting-logbook/types';
import { LiftRecord } from '../../models';

/**
 * Soft variant of the lift-records validator (Phase 3 — interactive REVIEW step).
 *
 * Rather than a single valid/errors split, rows are classified into four buckets:
 *   - valid:       fully valid; can be committed as-is
 *   - incomplete:  missing a numeric required field (cycleNum, workoutNum, setNum,
 *                  weight, reps, or date); can be committed after a bulk-edit fix
 *   - ambiguous:   all numeric fields OK but lift name not in slotMap; user can
 *                  pick a canonical name via the lift-catalog autocomplete
 *   - hardErrors:  completely malformed rows that cannot be recovered (reserved for
 *                  future use — currently all errors map to incomplete or ambiguous)
 *
 * Valid rows have their lift abbreviation resolved to the canonical ID (same as the
 * strict validator). Ambiguous rows keep their original lift string so the REVIEW
 * step can show it in the autocomplete placeholder.
 *
 * Called by the preview path only; the commit path continues to use validateLiftImport.
 */
export interface LiftImportSoftResult {
  valid: LiftRecord[];
  incomplete: Array<{ record: LiftRecord; rowIndex: number; errors: ImportError[] }>;
  ambiguous: Array<{ record: LiftRecord; rowIndex: number; originalLift: string }>;
  hardErrors: ImportError[];
}

export function validateLiftImportSoft(
  records: LiftRecord[],
  slotMap: Readonly<Record<string, string>>,
): LiftImportSoftResult {
  const valid: LiftRecord[] = [];
  const incomplete: LiftImportSoftResult['incomplete'] = [];
  const ambiguous: LiftImportSoftResult['ambiguous'] = [];
  const hardErrors: ImportError[] = [];

  records.forEach((r, i) => {
    const rowIndex = i + 1;
    const numericErrors: ImportError[] = [];

    if (isNaN(r.cycleNum))
      numericErrors.push({ row: rowIndex, field: 'cycleNum', code: 'CYCLE_NUM_INVALID', message: 'cycleNum is not a number' });
    if (isNaN(r.workoutNum))
      numericErrors.push({ row: rowIndex, field: 'workoutNum', code: 'WORKOUT_NUM_INVALID', message: 'workoutNum is not a number' });
    if (isNaN(r.setNum))
      numericErrors.push({ row: rowIndex, field: 'setNum', code: 'SET_NUM_INVALID', message: 'setNum is not a number' });
    if (isNaN(r.weight))
      numericErrors.push({ row: rowIndex, field: 'weight', code: 'WEIGHT_INVALID', message: 'weight is not a number' });
    if (isNaN(r.reps))
      numericErrors.push({ row: rowIndex, field: 'reps', code: 'REPS_INVALID', message: 'reps is not a number' });
    if (!r.date || isNaN(r.date.getTime()))
      numericErrors.push({ row: rowIndex, field: 'date', code: 'DATE_INVALID', message: 'date is invalid' });

    if (numericErrors.length > 0) {
      incomplete.push({ record: r, rowIndex, errors: numericErrors });
      return;
    }

    // String(r.lift ?? ''), not a bare `as unknown as string` cast — see
    // validateLiftImport.ts's own comment: r.lift is genuinely `undefined`
    // for a missing Lift column (as opposed to a present-but-blank cell), and
    // `.trim()` called directly on `undefined` throws instead of falling
    // through to the ambiguous bucket below (#911 review, fourth pass — a
    // regression in the third pass's trim-for-parity fix).
    const liftStr = String(r.lift ?? '').trim();
    // Object.prototype.hasOwnProperty.call, not the `in` operator — see
    // validateLiftImport.ts for why.
    if (!liftStr || !Object.prototype.hasOwnProperty.call(slotMap, liftStr)) {
      ambiguous.push({ record: r, rowIndex, originalLift: liftStr });
      return;
    }

    valid.push({ ...r, lift: slotMap[liftStr]! as LiftRecord['lift'] });
  });

  return { valid, incomplete, ambiguous, hardErrors };
}
