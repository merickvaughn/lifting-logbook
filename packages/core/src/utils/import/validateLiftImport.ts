import { ImportError, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
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

    // String(r.lift ?? ''), not a bare `as unknown as string` cast: r.lift is
    // genuinely `undefined` whenever the uploaded table has no column mapped
    // to `lift` (tableToObjects only assigns keys for headers actually
    // present), and this file's own MAP_COLUMNS step exists precisely to let
    // a user fix a differently-named exercise column — a `.trim()` called
    // directly on that `undefined` throws a TypeError instead of falling
    // through to the blank-lift branch below, turning exactly the recoverable
    // case this validator is supposed to handle into an unhandled 500 (#911
    // review, fourth pass — a regression in the third pass's own trim-for-
    // parity fix, which is otherwise correct: trimmed for parity with
    // validateTrainingMaxImport/validateStrengthGoalImport, both of which
    // already use this exact `String(... ?? '').trim()` form).
    const liftStr = String(r.lift ?? '').trim();
    // Object.prototype.hasOwnProperty.call, not the `in` operator: `in` walks
    // the prototype chain, so a lift string of "toString"/"constructor"/
    // "__proto__"/etc. would otherwise resolve to an inherited Object.prototype
    // member instead of failing like any other unrecognized name (issue #911
    // review — slotMap's keys are partially user-controlled via custom lift
    // names since buildEffectiveSlotMap). Object.hasOwn is the modern spelling
    // of this same check but needs an ES2022+ lib target this package doesn't
    // configure.
    if (!liftStr) {
      // Distinct from the "unrecognized name" case below — interpolating
      // liftStr here would render as `'undefined' isn't a recognized
      // exercise` for a blank cell or a missing Lift column, telling the user
      // to map/create an exercise literally named "undefined" (#911 review,
      // second pass). A missing column produces this on every row, so the
      // wrong message would be the dominant experience for that failure mode.
      rowErrors.push({
        row,
        field: IMPORT_ERROR_FIELD_LIFT,
        message: 'Row has no exercise name — check that your file has a "Lift" column.',
      });
    } else if (!Object.prototype.hasOwnProperty.call(slotMap, liftStr)) {
      // Object.prototype.hasOwnProperty.call, not the `in` operator: `in`
      // walks the prototype chain, so a lift string of
      // "toString"/"constructor"/"__proto__"/etc. would otherwise resolve to
      // an inherited Object.prototype member instead of failing like any
      // other unrecognized name (issue #911 review — slotMap's keys are
      // partially user-controlled via custom lift names since
      // buildEffectiveSlotMap). Object.hasOwn is the modern spelling of this
      // same check but needs an ES2022+ lib target this package doesn't configure.
      //
      // Kept UI/route-agnostic (no mention of a specific screen or wizard) —
      // this message is surfaced verbatim by more than one caller, including
      // at least one with no interactive remap capability of its own (issue #911).
      rowErrors.push({
        row,
        field: IMPORT_ERROR_FIELD_LIFT,
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
