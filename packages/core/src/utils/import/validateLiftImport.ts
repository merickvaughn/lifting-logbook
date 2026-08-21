import { ImportError } from '@lifting-logbook/types';
import { LiftRecord } from '../../models';

export interface LiftImportValidationResult {
  /** Records that passed all validation checks, with lift abbreviations resolved to canonical IDs. */
  valid: LiftRecord[];
  /** All errors encountered across all rows. */
  errors: ImportError[];
}

/**
 * Validates an array of parsed LiftRecord rows against the provided slot map and
 * collects all errors before returning (all-or-nothing semantics).
 *
 * Row numbers are 1-based and exclude the CSV header row.
 *
 * When a row is valid, its `lift` field is resolved from the CSV abbreviation
 * (e.g. "Bench P.") to the canonical lift ID (e.g. "bench-press") via slotMap.
 */
export function validateLiftImport(
  records: LiftRecord[],
  slotMap: Readonly<Record<string, string>>,
): LiftImportValidationResult {
  const valid: LiftRecord[] = [];
  const errors: ImportError[] = [];

  records.forEach((r, i) => {
    const row = i + 1;
    const rowErrors: ImportError[] = [];

    if (isNaN(r.cycleNum))
      rowErrors.push({ row, field: 'cycleNum', message: 'cycleNum is not a number' });
    if (isNaN(r.workoutNum))
      rowErrors.push({ row, field: 'workoutNum', message: 'workoutNum is not a number' });
    if (isNaN(r.setNum))
      rowErrors.push({ row, field: 'setNum', message: 'setNum is not a number' });
    if (isNaN(r.weight))
      rowErrors.push({ row, field: 'weight', message: 'weight is not a number' });
    if (isNaN(r.reps))
      rowErrors.push({ row, field: 'reps', message: 'reps is not a number' });
    if (!r.date || isNaN(r.date.getTime()))
      rowErrors.push({ row, field: 'date', message: 'date is invalid' });

    const liftStr = r.lift as unknown as string;
    if (!liftStr || !(liftStr in slotMap)) {
      // Kept UI/route-agnostic (no mention of a specific screen or wizard) — this
      // message is surfaced verbatim by more than one caller, including at least
      // one with no interactive remap capability of its own (issue #911).
      rowErrors.push({
        row,
        field: 'lift',
        message: `'${liftStr}' isn't a recognized exercise. Map it to an existing exercise or create a new one before importing.`,
      });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      valid.push({ ...r, lift: slotMap[liftStr]! as LiftRecord['lift'] });
    }
  });

  return { valid, errors };
}
