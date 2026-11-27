import { validateLiftImportSoft } from './validateLiftImportSoft';
import { builtInLiftFor } from '../../catalog/builtInLift';
import { LIFT_CATALOG } from '../../catalog/lifts';
import { DEFAULT_SLOT_MAP, buildImportSlotMap } from '../../catalog/slotMaps';
import type { LiftRecord } from '../../models';

function record(overrides: Partial<LiftRecord> = {}): LiftRecord {
  return {
    program: 'prog', macrocycleNum: 1, workoutNum: 1, date: new Date('2026-01-01'),
    lift: 'Squat', setNum: 1, weight: 100, reps: 5, notes: '',
    ...overrides,
  };
}

// Use the default slot map so we get realistic "known" vs "unknown" lifts.
const SLOT_MAP = DEFAULT_SLOT_MAP;

// A known lift that resolves to a canonical ID in the slot map.
const KNOWN_LIFT = Object.keys(SLOT_MAP)[0]!; // e.g. 'squat'
// An unknown lift that has no entry.
const UNKNOWN_LIFT = '__not_a_real_lift_zzzz__';

describe('validateLiftImportSoft', () => {
  it('puts a fully-valid row in the valid bucket', () => {
    const r = record({ lift: KNOWN_LIFT });
    const result = validateLiftImportSoft([r], SLOT_MAP);
    expect(result.validRows).toHaveLength(1);
    expect(result.incomplete).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.hardErrors).toHaveLength(0);
  });

  it('records the file position of each valid row (#1123)', () => {
    const result = validateLiftImportSoft(
      [record({ lift: KNOWN_LIFT }), record({ lift: UNKNOWN_LIFT }), record({ lift: KNOWN_LIFT })],
      SLOT_MAP,
    );
    expect(result.validRows.map((v) => v.rowIndex)).toEqual([1, 3]);
  });

  it('puts a row whose complex round the commit would reject in the incomplete bucket (#1494)', () => {
    const rows = [0, 2.5, NaN, 3_000_000_000, 2].map((complexRound) => record({ lift: KNOWN_LIFT, complex: 'Complex 1A', complexRound }));
    const result = validateLiftImportSoft(rows, SLOT_MAP);
    expect(result.incomplete.map((r) => [r.rowIndex, r.errors.map((e) => e.code)])).toEqual(
      [1, 2, 3, 4].map((row) => [row, ['COMPLEX_ROUND_INVALID']]),
    );
    expect(result.validRows).toHaveLength(1);
  });

  it('puts a row with NaN weight in the incomplete bucket', () => {
    const r = record({ lift: KNOWN_LIFT, weight: NaN });
    const result = validateLiftImportSoft([r], SLOT_MAP);
    expect(result.incomplete).toHaveLength(1);
    expect(result.validRows).toHaveLength(0);
    expect(result.incomplete[0]!.errors).toMatchObject([{ field: 'weight', code: 'WEIGHT_INVALID' }]);
  });

  it('puts a row whose macrocycle number is outside 0 to 1000 in the incomplete bucket', () => {
    const rows = [-1, 0, 1000, 1001, 2.5].map((macrocycleNum) => record({ lift: KNOWN_LIFT, macrocycleNum }));
    const result = validateLiftImportSoft(rows, SLOT_MAP);
    expect(result.validRows.map((v) => v.rowIndex)).toEqual([2, 3]);
    expect(result.incomplete.map((r) => [r.rowIndex, r.errors])).toEqual(
      [1, 4, 5].map((row) => [
        row,
        [{ row, field: 'macrocycleNum', code: 'MACROCYCLE_NUM_INVALID', message: 'Macrocycle # must be a whole number from 0 to 1000' }],
      ]),
    );
  });

  // #1402: the strict validator has rejected these dates since #1316, but the soft validator
  // checked only that the date parsed, so Review listed a 1969 row as an ordinary create and the
  // Assign step was the first thing to refuse it — with a bare "Validation failed".
  describe('date range (#1402)', () => {
    const importDate = new Date('2026-11-22T15:00:00Z');

    it.each([
      ['an epoch-artefact date', '1969-12-31', '1969-12-31'],
      ['a date after the import day', '2026-11-23', '2026-11-23'],
    ])('puts a row with %s in the incomplete bucket', (_label, date, isoDay) => {
      const result = validateLiftImportSoft([record({ lift: KNOWN_LIFT, date: new Date(date) })], SLOT_MAP, {
        importDate,
      });
      expect(result.validRows).toHaveLength(0);
      expect(result.incomplete.map((r) => [r.rowIndex, r.errors])).toEqual([
        [
          1,
          [
            {
              row: 1,
              field: 'date',
              code: 'DATE_INVALID',
              message: `Date ${isoDay} must be after 1970-01-01 and no later than 2026-11-22`,
            },
          ],
        ],
      ]);
    });

    it.each([
      ['the earliest allowed day', '1970-01-02'],
      ['the import day itself', '2026-11-22'],
    ])('keeps a row dated %s valid', (_label, date) => {
      const result = validateLiftImportSoft([record({ lift: KNOWN_LIFT, date: new Date(date) })], SLOT_MAP, {
        importDate,
      });
      expect(result.incomplete).toHaveLength(0);
      expect(result.validRows).toHaveLength(1);
    });
  });

  it('puts a row with unknown lift in the ambiguous bucket', () => {
    const r = record({ lift: UNKNOWN_LIFT });
    const result = validateLiftImportSoft([r], SLOT_MAP);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.originalLift).toBe(UNKNOWN_LIFT);
    expect(result.validRows).toHaveLength(0);
  });

  it('handles a mix of valid, incomplete, and ambiguous rows', () => {
    const rows = [
      record({ lift: KNOWN_LIFT }),
      record({ lift: KNOWN_LIFT, weight: NaN }),
      record({ lift: UNKNOWN_LIFT }),
    ];
    const result = validateLiftImportSoft(rows, SLOT_MAP);
    expect(result.validRows).toHaveLength(1);
    expect(result.incomplete).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(1);
  });

  it('returns empty buckets for empty input', () => {
    const result = validateLiftImportSoft([], SLOT_MAP);
    expect(result.validRows).toHaveLength(0);
    expect(result.incomplete).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.hardErrors).toHaveLength(0);
  });

  // Regression guard (#911 review, third pass): parity with
  // validateLiftImport (see its own test) — an untrimmed known lift value
  // previously failed the exact-case slotMap lookup and landed in the
  // ambiguous bucket instead of valid.
  it('trims whitespace before resolving a known lift', () => {
    const r = record({ lift: `  ${KNOWN_LIFT}  ` });
    const result = validateLiftImportSoft([r], SLOT_MAP);
    expect(result.validRows).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(0);
  });

  // Regression guard (#911 review, fourth pass): a genuinely missing Lift
  // COLUMN (r.lift undefined, distinct from a present-but-blank '' cell) must
  // land in the ambiguous bucket, not throw — see validateLiftImport.test.ts
  // for the full rationale.
  it('puts a row with an undefined lift (a missing Lift column) in the ambiguous bucket, without throwing', () => {
    const r = record({ lift: undefined as unknown as string });
    expect(() => validateLiftImportSoft([r], SLOT_MAP)).not.toThrow();
    const result = validateLiftImportSoft([r], SLOT_MAP);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.originalLift).toBe('');
    expect(result.validRows).toHaveLength(0);
  });

  // Regression guard (#911 review): membership must be Object.hasOwn, not the `in`
  // operator, which walks the prototype chain — "toString"/"constructor"/"__proto__"
  // must land in the ambiguous bucket like any other unrecognized name, not resolve
  // via an inherited Object.prototype member.
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])(
    "puts a row with lift '%s' in the ambiguous bucket rather than resolving it via the prototype chain",
    (liftStr) => {
      const r = record({ lift: liftStr });
      const result = validateLiftImportSoft([r], SLOT_MAP);
      expect(result.ambiguous).toHaveLength(1);
      expect(result.validRows).toHaveLength(0);
    },
  );

  // #1116: these rows used to land in `ambiguous`, so the only way through was a
  // custom lift duplicating the built-in.
  it("does not flag any catalog lift's display name or id as ambiguous", () => {
    const importMap = buildImportSlotMap([]);
    expect(LIFT_CATALOG.length).toBeGreaterThan(0);
    for (const lift of LIFT_CATALOG) {
      for (const form of [lift.name, lift.id]) {
        const result = validateLiftImportSoft([record({ lift: form })], importMap);
        expect({ form, ambiguous: result.ambiguous }).toEqual({ form, ambiguous: [] });
        expect(builtInLiftFor(result.validRows[0]!.record.lift)?.id).toBe(lift.id);
      }
    }
  });
});
