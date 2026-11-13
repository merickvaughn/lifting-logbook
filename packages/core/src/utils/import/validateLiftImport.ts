import { ImportError, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import { LiftRecord } from '../../models';
import type { AssignBlankField, ParsedLiftRecord } from '../parser/parseLiftRecords';

/**
 * The highest macrocycle number a file may carry: the bound `POST lift-records` already
 * applies. A file's number only groups its rows and is never stored (#1199): each group joins a
 * stored macrocycle or forms one numbered past them. The bound stays so a number far out of range
 * (a date or a weight in the wrong column) gets a row error naming it, the same one either path
 * gives. The lowest is 0, not the 1 a live
 * macrocycle starts at: spreadsheet exports number a first cycle 0
 * (`packages/core/tests/fixtures/lift_records.csv`).
 */
export const MAX_FILE_MACROCYCLE_NUM = 1000;

/** The row error for a file macrocycle number outside 0 to {@link MAX_FILE_MACROCYCLE_NUM}, or null. */
export function fileMacrocycleNumError(row: number, macrocycleNum: number): ImportError | null {
  if (isNaN(macrocycleNum)) return null;
  if (Number.isInteger(macrocycleNum) && macrocycleNum >= 0 && macrocycleNum <= MAX_FILE_MACROCYCLE_NUM) return null;
  return {
    row,
    field: 'macrocycleNum',
    code: 'MACROCYCLE_NUM_INVALID',
    message: `Macrocycle # must be a whole number from 0 to ${MAX_FILE_MACROCYCLE_NUM}`,
  };
}

export interface LiftImportValidationResult {
  /** Records that passed all validation checks, with each lift resolved to the value slotMap holds for it. */
  valid: LiftRecord[];
  /** All errors encountered across all rows. */
  errors: ImportError[];
  /** With {@link LiftImportOptions.assign}, the rows with no date, left out unchecked. Otherwise empty. */
  undated: LiftRecord[];
}

/** How a lift-records file is validated. */
export interface LiftImportOptions {
  /**
   * The file goes through the Assign step (#1253), which groups rows into macrocycles from their
   * dates (proposal decisions 9 and 16). A missing macrocycle or workout number isn't an error,
   * and a row with no date is left out and counted rather than failing the file.
   */
  assign?: boolean;
}

/**
 * With {@link LiftImportOptions.assign}, whether the file left this field blank: the Assign
 * step reads it as "not given". A cell that isn't blank but can't be read is still an error.
 */
export function assignBlank(r: ParsedLiftRecord, field: AssignBlankField, options: LiftImportOptions): boolean {
  return options.assign === true && (r.blankFields?.includes(field) ?? false);
}

/**
 * Validates an array of parsed LiftRecord rows against the provided slot map and
 * collects all errors before returning (all-or-nothing semantics).
 *
 * Row numbers are 1-based and exclude the CSV header row.
 *
 * When a row is valid, its `lift` field is resolved via slotMap: from a CSV
 * abbreviation (e.g. "Bench P.") to the canonical lift ID (e.g. "bench-press").
 * Under buildImportSlotMap, a catalog lift outside DEFAULT_SLOT_MAP resolves to
 * its display name instead (issue #1116), and an alias stays as written (issue #947).
 */
export function validateLiftImport(
  records: ParsedLiftRecord[],
  slotMap: Readonly<Record<string, string>>,
  options: LiftImportOptions = {},
): LiftImportValidationResult {
  const valid: LiftRecord[] = [];
  const errors: ImportError[] = [];
  const undated: LiftRecord[] = [];

  records.forEach((r, i) => {
    const row = i + 1;
    const rowErrors: ImportError[] = [];

    if (assignBlank(r, 'date', options)) {
      undated.push(r);
      return;
    }
    if (isNaN(r.macrocycleNum) && !assignBlank(r, 'macrocycleNum', options))
      rowErrors.push({ row, field: 'macrocycleNum', code: 'MACROCYCLE_NUM_INVALID', message: 'Macrocycle # is not a number' });
    const outOfRange = fileMacrocycleNumError(row, r.macrocycleNum);
    if (outOfRange) rowErrors.push(outOfRange);
    if (isNaN(r.workoutNum) && !assignBlank(r, 'workoutNum', options))
      rowErrors.push({ row, field: 'workoutNum', code: 'WORKOUT_NUM_INVALID', message: 'Workout # is not a number' });
    if (isNaN(r.setNum))
      rowErrors.push({ row, field: 'setNum', code: 'SET_NUM_INVALID', message: 'Set # is not a number' });
    if (isNaN(r.weight))
      rowErrors.push({ row, field: 'weight', code: 'WEIGHT_INVALID', message: 'Weight is not a number' });
    if (isNaN(r.reps))
      rowErrors.push({ row, field: 'reps', code: 'REPS_INVALID', message: 'Reps is not a number' });
    if (!r.date || isNaN(r.date.getTime()))
      rowErrors.push({ row, field: 'date', code: 'DATE_INVALID', message: 'date is invalid' });

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
    if (!liftStr) {
      // Distinct from the "unrecognized name" case below — interpolating
      // liftStr here would render as `'undefined' isn't a recognized
      // exercise` for a blank cell or a missing Lift column, telling the user
      // to map/create an exercise literally named "undefined" (#911 review,
      // second pass). A missing column produces this on every row, so the
      // wrong message would be the dominant experience for that failure mode.
      // code: LIFT_EMPTY (not UNRECOGNIZED_LIFT) — same code as the "lift is
      // empty" case in the other three validators (#913): this is a missing
      // value, not an unrecognized one.
      rowErrors.push({
        row,
        field: IMPORT_ERROR_FIELD_LIFT,
        code: 'LIFT_EMPTY',
        message: 'Row has no lift name — check that your file has a "Lift" column.',
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
        code: 'UNRECOGNIZED_LIFT',
        message: `'${liftStr}' isn't a recognized lift. Map it to an existing lift or create a new one before importing.`,
      });
    }

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      valid.push({ ...r, lift: slotMap[liftStr]! as LiftRecord['lift'] });
    }
  });

  return { valid, errors, undated };
}
