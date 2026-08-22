import { validateLiftImportSoft } from './validateLiftImportSoft';
import { DEFAULT_SLOT_MAP } from '../../catalog/slotMaps';
import type { LiftRecord } from '../../models';

function record(overrides: Partial<LiftRecord> = {}): LiftRecord {
  return {
    program: 'prog', cycleNum: 1, workoutNum: 1, date: new Date('2026-01-01'),
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
    expect(result.valid).toHaveLength(1);
    expect(result.incomplete).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.hardErrors).toHaveLength(0);
  });

  it('puts a row with NaN weight in the incomplete bucket', () => {
    const r = record({ lift: KNOWN_LIFT, weight: NaN });
    const result = validateLiftImportSoft([r], SLOT_MAP);
    expect(result.incomplete).toHaveLength(1);
    expect(result.valid).toHaveLength(0);
  });

  it('puts a row with unknown lift in the ambiguous bucket', () => {
    const r = record({ lift: UNKNOWN_LIFT });
    const result = validateLiftImportSoft([r], SLOT_MAP);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]!.originalLift).toBe(UNKNOWN_LIFT);
    expect(result.valid).toHaveLength(0);
  });

  it('handles a mix of valid, incomplete, and ambiguous rows', () => {
    const rows = [
      record({ lift: KNOWN_LIFT }),
      record({ lift: KNOWN_LIFT, weight: NaN }),
      record({ lift: UNKNOWN_LIFT }),
    ];
    const result = validateLiftImportSoft(rows, SLOT_MAP);
    expect(result.valid).toHaveLength(1);
    expect(result.incomplete).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(1);
  });

  it('returns empty buckets for empty input', () => {
    const result = validateLiftImportSoft([], SLOT_MAP);
    expect(result.valid).toHaveLength(0);
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
    expect(result.valid).toHaveLength(1);
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
    expect(result.valid).toHaveLength(0);
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
      expect(result.valid).toHaveLength(0);
    },
  );
});
