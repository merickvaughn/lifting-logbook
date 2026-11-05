import {
  buildLiftRecordId,
  liftRecordNaturalKey,
  parseLiftRecordId,
  parseLiftRecordNaturalKey,
  withModifications,
} from './liftRecordNaturalKey';

function record(overrides: Partial<Parameters<typeof liftRecordNaturalKey>[0]> = {}) {
  return {
    macrocycleNum: 3,
    workoutNum: 2,
    date: new Date('2026-08-17'),
    lift: 'Bench Press',
    setNum: 1,
    ...overrides,
  };
}

describe('withModifications', () => {
  it('carries a list that has ids, and leaves out an empty or absent one', () => {
    expect(withModifications(['a'])).toEqual({ modifications: ['a'] });
    expect(withModifications([])).toEqual({});
    expect(withModifications(undefined)).toEqual({});
  });
});

describe('liftRecordNaturalKey', () => {
  it('leaves modifications out of the key and the public id', () => {
    const modified = { ...record(), modifications: ['a'] };
    expect(liftRecordNaturalKey(modified)).toBe(liftRecordNaturalKey(record()));
    expect(buildLiftRecordId('p', modified)).toBe(buildLiftRecordId('p', record()));
  });

  it('includes the date segment in the key', () => {
    expect(liftRecordNaturalKey(record())).toBe('3:2:20260817:Bench Press:1');
  });

  // Core regression for issue #884: two sets sharing every field except date
  // must now produce different keys, so they're no longer treated as the
  // same record and silently collapsed.
  it('produces different keys for records that differ only by date', () => {
    const a = liftRecordNaturalKey(record({ date: new Date('2025-12-16') }));
    const b = liftRecordNaturalKey(record({ date: new Date('2024-01-12') }));
    expect(a).not.toBe(b);
  });

  it('produces the same key for records with an identical date (true duplicate)', () => {
    const a = liftRecordNaturalKey(record({ date: new Date('2026-08-17') }));
    const b = liftRecordNaturalKey(record({ date: new Date('2026-08-17') }));
    expect(a).toBe(b);
  });

  it('round-trips a lift name containing a hyphen', () => {
    const r = record({ lift: 'Chin-up' });
    const key = liftRecordNaturalKey(r);
    expect(parseLiftRecordNaturalKey(key)).toEqual(r);
  });

  it('round-trips a lift name containing a space and a hyphen', () => {
    const r = record({ lift: 'Romanian Dead-lift' });
    const key = liftRecordNaturalKey(r);
    expect(parseLiftRecordNaturalKey(key)).toEqual(r);
  });

  it('round-trips a lift name containing a colon', () => {
    const r = record({ lift: 'Cool:Down' });
    const key = liftRecordNaturalKey(r);
    expect(parseLiftRecordNaturalKey(key)).toEqual(r);
  });
});

describe('parseLiftRecordNaturalKey', () => {
  it('returns null for a key missing the date segment (pre-#884 format)', () => {
    expect(parseLiftRecordNaturalKey('3:2:Bench Press:1')).toBeNull();
  });

  it('returns null for a malformed date segment', () => {
    expect(parseLiftRecordNaturalKey('3:2:2026-08-17:Bench Press:1')).toBeNull();
  });

  it('returns null for non-numeric macrocycleNum/workoutNum/setNum', () => {
    expect(parseLiftRecordNaturalKey('x:2:20260817:Bench Press:1')).toBeNull();
  });

  it('returns null for too few segments', () => {
    expect(parseLiftRecordNaturalKey('3:2:20260817')).toBeNull();
  });
});

describe('buildLiftRecordId', () => {
  it('includes the program and date segments', () => {
    expect(buildLiftRecordId('531', record())).toBe('531-3-2-20260817-Bench Press-1');
  });

  it('produces different ids for records that differ only by date', () => {
    const a = buildLiftRecordId('531', record({ date: new Date('2025-12-16') }));
    const b = buildLiftRecordId('531', record({ date: new Date('2024-01-12') }));
    expect(a).not.toBe(b);
  });
});

describe('occurrence (#1027)', () => {
  it('leaves a first occurrence’s key and id as they were before occurrences existed', () => {
    expect(liftRecordNaturalKey(record({ occurrence: 0 }))).toBe('3:2:20260817:Bench Press:1');
    expect(buildLiftRecordId('531', record({ occurrence: 0 }))).toBe('531-3-2-20260817-Bench Press-1');
  });

  it('tells a later occurrence’s set apart from the first occurrence’s', () => {
    expect(liftRecordNaturalKey(record({ occurrence: 1 }))).toBe('3:2:20260817:Bench Press:1~1');
    expect(buildLiftRecordId('531', record({ occurrence: 1 }))).toBe('531-3-2-20260817-Bench Press-1~1');
  });

  it('round-trips a later occurrence through the key and the id, hyphenated lift and all', () => {
    const r = record({ lift: 'Chin-up', occurrence: 2, setNum: 3 });
    expect(parseLiftRecordNaturalKey(liftRecordNaturalKey(r))).toEqual(r);
    expect(parseLiftRecordId('531', buildLiftRecordId('531', r))).toEqual(r);
  });

  it('parses a first occurrence with the occurrence absent', () => {
    expect(parseLiftRecordId('531', '531-3-2-20260817-Bench Press-1')).toEqual(record());
    expect(parseLiftRecordNaturalKey('3:2:20260817:Bench Press:1~0')).toEqual(record());
  });

  it('rejects a malformed occurrence', () => {
    expect(parseLiftRecordNaturalKey('3:2:20260817:Bench Press:1~x')).toBeNull();
    expect(parseLiftRecordNaturalKey('3:2:20260817:Bench Press:1~1~1')).toBeNull();
    expect(parseLiftRecordId('531', '531-3-2-20260817-Bench Press-1~x')).toBeNull();
  });

  it('rejects an id of another program', () => {
    expect(parseLiftRecordId('rpt', '531-3-2-20260817-Bench Press-1')).toBeNull();
  });
});
