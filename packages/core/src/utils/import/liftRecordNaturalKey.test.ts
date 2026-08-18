import {
  buildLiftRecordId,
  liftRecordNaturalKey,
  parseLiftRecordNaturalKey,
} from './liftRecordNaturalKey';

function record(overrides: Partial<Parameters<typeof liftRecordNaturalKey>[0]> = {}) {
  return {
    cycleNum: 3,
    workoutNum: 2,
    date: new Date('2026-08-17'),
    lift: 'Bench Press',
    setNum: 1,
    ...overrides,
  };
}

describe('liftRecordNaturalKey', () => {
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

  it('returns null for non-numeric cycleNum/workoutNum/setNum', () => {
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
