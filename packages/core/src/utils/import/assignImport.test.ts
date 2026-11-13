import { DEFAULT_SLOT_MAP } from '../../catalog/slotMaps';
import type { LiftRecord } from '../../models';
import { fuzzyColumnMapper } from '../mapper/fuzzyColumnMapper';
import { parseLiftRecords } from '../parser/parseLiftRecords';
import { buildLiftRecordsPreviewSoft } from './buildImportPreview';
import { isLiftRecordExport, toLiftHistoryRecord } from './liftHistoryRows';
import { validateLiftImport } from './validateLiftImport';
import { validateLiftImportSoft } from './validateLiftImportSoft';

/** The `assign` options and helpers the import wizard's Assign step reads files through (#1253). */

// A slot the default map resolves.
const KNOWN_LIFT = 'Squat';

function record(overrides: Partial<LiftRecord> = {}): LiftRecord {
  return {
    program: 'rpt',
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2026-01-05T00:00:00Z'),
    lift: KNOWN_LIFT,
    setNum: 1,
    weight: 100,
    reps: 5,
    notes: '',
    ...overrides,
  };
}

const noNumbers = { macrocycleNum: NaN, workoutNum: NaN };
const noDate = { date: new Date(NaN) };

describe('parseLiftRecords with assign', () => {
  const table = [
    ['Cycle #', 'Workout #', 'Date', 'Lift', 'Set #', 'Weight', 'Reps'],
    ['', ' ', '2026-01-05', 'Squat', '', '100', '5'],
    ['0', '3', '2026-01-07', 'Squat', '1', '100', '5'],
  ];

  it('reads a blank macrocycle or workout number as NaN, and a real 0 as 0', () => {
    expect(parseLiftRecords(table, { assign: true })).toEqual([
      expect.objectContaining({ macrocycleNum: NaN, workoutNum: NaN }),
      expect.objectContaining({ macrocycleNum: 0, workoutNum: 3 }),
    ]);
  });

  it('leaves other blank numbers as they were', () => {
    expect(parseLiftRecords(table, { assign: true })[0]).toMatchObject({ setNum: 0 });
  });

  it('without it, a blank number reads as 0, as before', () => {
    expect(parseLiftRecords(table)[0]).toMatchObject({ macrocycleNum: 0 });
  });
});

describe('fuzzyColumnMapper with assign', () => {
  const missing = (assign: boolean) =>
    fuzzyColumnMapper(['Date', 'Lift', 'Set #', 'Weight', 'Reps'], 'lift-records', { assign })
      .filter((m) => m.required && m.sourceHeader === '')
      .map((m) => m.destinationField)
      .sort();

  it('does not require program, macrocycle or workout columns', () => {
    expect(missing(true)).toEqual([]);
  });

  it('without it, still requires them', () => {
    expect(missing(false)).toEqual(['macrocycleNum', 'program', 'workoutNum']);
  });
});

describe('validateLiftImport with assign', () => {
  it('accepts a row with no macrocycle or workout number', () => {
    const { valid, errors } = validateLiftImport([record(noNumbers)], DEFAULT_SLOT_MAP, { assign: true });
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
  });

  it('leaves a row with no date out unchecked, and still checks the rest', () => {
    const undatedRow = record({ ...noDate, weight: NaN });
    const { valid, errors, undated } = validateLiftImport(
      [undatedRow, record({ weight: NaN })],
      DEFAULT_SLOT_MAP,
      { assign: true },
    );
    expect(undated).toEqual([undatedRow]);
    expect(valid).toEqual([]);
    expect(errors.map((e) => [e.row, e.code])).toEqual([[2, 'WEIGHT_INVALID']]);
  });

  it('still rejects a macrocycle number out of range', () => {
    const { errors } = validateLiftImport([record({ macrocycleNum: 5000 })], DEFAULT_SLOT_MAP, { assign: true });
    expect(errors.map((e) => e.code)).toEqual(['MACROCYCLE_NUM_INVALID']);
  });

  it('without it, a missing number or date is still an error', () => {
    const { errors, undated } = validateLiftImport([record({ ...noNumbers, ...noDate })], DEFAULT_SLOT_MAP);
    expect(errors.map((e) => e.code).sort()).toEqual(['DATE_INVALID', 'MACROCYCLE_NUM_INVALID', 'WORKOUT_NUM_INVALID']);
    expect(undated).toEqual([]);
  });
});

describe('validateLiftImportSoft and the preview with assign', () => {
  it('accepts a row with no numbers, and lists a row with no date as undated rather than incomplete', () => {
    const result = validateLiftImportSoft([record(noNumbers), record(noDate)], DEFAULT_SLOT_MAP, { assign: true });
    expect(result.validRows.map((r) => r.rowIndex)).toEqual([1]);
    expect(result.undated?.map((r) => r.rowIndex)).toEqual([2]);
    expect(result.incomplete).toEqual([]);

    const preview = buildLiftRecordsPreviewSoft(result, [], new Map());
    expect(preview.deltas.find((d) => d.rowIndex === 2)).toEqual(
      expect.objectContaining({ key: '__undated_2', status: 'undated', kind: 'skip' }),
    );
    // Left out, not skipped as already stored, and not held at the incomplete-row gate.
    expect([preview.creates, preview.skips, preview.unresolved]).toEqual([1, 0, 0]);
  });

  it('without it, both rows are incomplete and there is no undated bucket', () => {
    const result = validateLiftImportSoft([record(noNumbers), record(noDate)], DEFAULT_SLOT_MAP);
    expect(result.incomplete.map((r) => r.rowIndex)).toEqual([1, 2]);
    expect(result.undated).toBeUndefined();
  });
});

describe('toLiftHistoryRecord', () => {
  it('reads a blank program and missing numbers as null', () => {
    expect(toLiftHistoryRecord(record({ program: '  ', ...noNumbers }))).toEqual(
      expect.objectContaining({ program: null, macrocycleNum: null, workoutNum: null }),
    );
  });

  it('keeps what the file says', () => {
    expect(toLiftHistoryRecord(record({ program: '5/3/1', macrocycleNum: 0, workoutNum: 4 }))).toEqual(
      expect.objectContaining({ program: '5/3/1', macrocycleNum: 0, workoutNum: 4, lift: KNOWN_LIFT }),
    );
  });

  it('reads a missing Program column as null', () => {
    const { program: _program, ...rest } = record();
    expect(toLiftHistoryRecord(rest as LiftRecord).program).toBeNull();
  });
});

describe('isLiftRecordExport', () => {
  it('is true only with an Occurrence column', () => {
    expect(isLiftRecordExport(['Program', 'Date', ' occurrence ', 'Lift'])).toBe(true);
    expect(isLiftRecordExport(['Program', 'Date', 'Lift', null])).toBe(false);
  });
});
