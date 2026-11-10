import {
  PRESET_BASE_SPECS,
  parseProgramSpecFlexible,
  BUILT_IN_KNOWN_PROGRAMS,
  KnownProgram,
  inferProgramFromLiftRecords,
  knownProgramFromSpec,
  liftKey,
  matchProgramForLifts,
} from '.';
import { matchProgramForKeys, programNameKey } from './programMatching';

const LIFTS_531 = ['Squat', 'Bench Press', 'Deadlift', 'Overhead Press'];
const LIFTS_LEANGAINS = [
  'Bench Press', 'Weighted Pull-ups', 'Incline DB Press', 'Cable Row',
  'Squat', 'Romanian Deadlift', 'Leg Curl', 'Calf Raises',
  'Overhead Press', 'Deadlift', 'Lateral Raises', 'Dips',
];
const LIFTS_RPT = [
  'Bench Press', 'Barbell Row', 'Overhead Press',
  'Squat', 'Romanian Deadlift', 'Calf Raises',
  'Deadlift', 'Weighted Pull-ups', 'Dips',
];

describe('PRESET_BASE_SPECS', () => {
  it('exposes 5-3-1, leangains, and rpt entries', () => {
    expect(Object.keys(PRESET_BASE_SPECS)).toContain('5-3-1');
    expect(Object.keys(PRESET_BASE_SPECS)).toContain('leangains');
    expect(Object.keys(PRESET_BASE_SPECS)).toContain('rpt');
  });

  it('5-3-1 covers the four main lifts across 3 weeks', () => {
    const spec = PRESET_BASE_SPECS['5-3-1'];
    expect(spec).toBeDefined();
    if (!spec) return;
    const lifts = [...new Set(spec.map((r) => r.lift))].sort();
    expect(lifts).toEqual([...LIFTS_531].sort());
    const weeks = [...new Set(spec.map((r) => r.week))].sort();
    expect(weeks).toEqual([1, 2, 3]);
  });

  it('leangains covers three workout days (offsets 0, 2, 4)', () => {
    const spec = PRESET_BASE_SPECS['leangains'];
    expect(spec).toBeDefined();
    if (!spec) return;
    const offsets = [...new Set(spec.map((r) => r.offset))].sort((a, b) => a - b);
    expect(offsets).toEqual([0, 2, 4]);
  });

  it('rpt covers three workout days (offsets 0, 2, 4)', () => {
    const spec = PRESET_BASE_SPECS['rpt'];
    expect(spec).toBeDefined();
    if (!spec) return;
    const offsets = [...new Set(spec.map((r) => r.offset))].sort((a, b) => a - b);
    expect(offsets).toEqual([0, 2, 4]);
  });

  it('rpt includes all 9 expected lifts', () => {
    const spec = PRESET_BASE_SPECS['rpt'];
    expect(spec).toBeDefined();
    if (!spec) return;
    const lifts = [...new Set(spec.map((r) => r.lift))].sort();
    expect(lifts).toEqual([...LIFTS_RPT].sort());
  });

  it('rpt compound RPT sets have amrap:true and wtDecrementPct:0.1', () => {
    const spec = PRESET_BASE_SPECS['rpt'];
    expect(spec).toBeDefined();
    if (!spec) return;
    const rptRows = spec.filter((r) => r.amrap === true);
    expect(rptRows.length).toBeGreaterThan(0);
    for (const row of rptRows) {
      expect(row.wtDecrementPct).toBe(0.1);
    }
  });

  it('rpt Calf Raises are isolation with no decrement', () => {
    const spec = PRESET_BASE_SPECS['rpt'];
    expect(spec).toBeDefined();
    if (!spec) return;
    const calf = spec.find((r) => r.lift === 'Calf Raises');
    expect(calf).toBeDefined();
    expect(calf?.activation).toBe('isolation');
    expect(calf?.amrap).toBe(false);
    expect(calf?.wtDecrementPct).toBe(0);
  });
});

describe('parseProgramSpecFlexible', () => {
  const validRow = {
    week: 1, offset: 0, lift: 'Squat', increment: 5, order: 1,
    sets: 3, reps: 5, amrap: true, warmUpPct: '0.4,0.5,0.6',
    wtDecrementPct: 0.1, activation: 'compound',
  };

  it('returns null for an empty array', () => {
    expect(parseProgramSpecFlexible([])).toBeNull();
  });

  it('returns the typed array for valid rows', () => {
    const rows = PRESET_BASE_SPECS['5-3-1'];
    expect(rows).toBeDefined();
    if (!rows) return;
    expect(parseProgramSpecFlexible(rows)).toEqual(rows);
  });

  it('accepts amrap as a string', () => {
    expect(parseProgramSpecFlexible([{ ...validRow, amrap: 'true' }])).not.toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const { lift: _omit, ...noLift } = validRow;
    expect(parseProgramSpecFlexible([noLift])).toBeNull();
  });

  it('returns null when a field has the wrong type', () => {
    expect(parseProgramSpecFlexible([{ ...validRow, week: '1' }])).toBeNull();
  });

  it('returns null if any row is invalid (fails fast)', () => {
    const rows = [validRow, { ...validRow, sets: 'three' }];
    expect(parseProgramSpecFlexible(rows)).toBeNull();
  });

  it('returns null for a null item in the array', () => {
    expect(parseProgramSpecFlexible([null])).toBeNull();
  });

  it('returns null for a primitive item in the array', () => {
    expect(parseProgramSpecFlexible(['string'])).toBeNull();
  });
});

describe('BUILT_IN_KNOWN_PROGRAMS', () => {
  it('knows each preset, its lifts and the length of one run', () => {
    const byId = new Map(BUILT_IN_KNOWN_PROGRAMS.map((p) => [p.id, p]));
    expect(byId.get('leangains')).toMatchObject({ workoutCount: 36, lengthWeeks: 12 });
    expect(byId.get('rpt')).toMatchObject({ workoutCount: 24, lengthWeeks: 8 });
    expect(byId.get('5-3-1')).toMatchObject({ workoutCount: 24, lengthWeeks: 12 });
    expect(byId.get('5-3-1')?.lifts.size).toBe(4);
  });

  it("expects each lift's sets in its author's order", () => {
    const byId = new Map(BUILT_IN_KNOWN_PROGRAMS.map((p) => [p.id, p]));
    // RPT and Leangains compounds fall from a top set; accessories are straight sets.
    expect(byId.get('rpt')?.setOrder.get(liftKey('Bench Press'))).toBe('descending');
    expect(byId.get('rpt')?.setOrder.get(liftKey('Calf Raises'))).toBe('straight');
    expect(byId.get('leangains')?.setOrder.get(liftKey('Incline DB Press'))).toBe('straight');
    // Wendler's 5/3/1 climbs to its top set, whatever the preset's rows say (#1086).
    expect(byId.get('5-3-1')?.setOrder.get(liftKey('Squat'))).toBe('ascending');
  });
});

describe('inferProgramFromLiftRecords', () => {
  it('returns null for an empty liftHistory', () => {
    expect(inferProgramFromLiftRecords([])).toBeNull();
  });

  it("returns '5-3-1' when history covers exactly those lifts", () => {
    expect(inferProgramFromLiftRecords(LIFTS_531)).toBe('5-3-1');
  });

  it('returns the smallest program containing every lift, not one the history covers', () => {
    // Squat and bench alone sit inside all three presets; 5-3-1 is the smallest.
    expect(inferProgramFromLiftRecords(['Squat', 'Bench Press'])).toBe('5-3-1');
    // Barbell Row is outside 5-3-1, so the four 5-3-1 lifts plus a row are RPT.
    expect(inferProgramFromLiftRecords([...LIFTS_531, 'Barbell Row'])).toBe('rpt');
  });

  it("returns 'leangains' when history covers all leangains lifts", () => {
    expect(inferProgramFromLiftRecords(LIFTS_LEANGAINS)).toBe('leangains');
  });

  it("returns 'rpt' when history covers exactly those lifts", () => {
    expect(inferProgramFromLiftRecords(LIFTS_RPT)).toBe('rpt');
  });

  it('returns null when no program contains every lift', () => {
    const combined = [...new Set([...LIFTS_LEANGAINS, ...LIFTS_RPT])];
    expect(inferProgramFromLiftRecords(combined)).toBeNull();
    expect(inferProgramFromLiftRecords(['Face Pull'])).toBeNull();
  });

  it('leaves out a lift in no built-in program, as import segmentation does', () => {
    expect(inferProgramFromLiftRecords(['Squat', 'Face Pull'])).toBe('5-3-1');
  });

  it('matches a lift under any of its spellings', () => {
    expect(inferProgramFromLiftRecords(['bench-press', 'Barbell Row'])).toBe('rpt');
  });
});

describe('matchProgramForKeys', () => {
  const custom = (id: string, lifts: string[]): KnownProgram => ({
    id,
    name: id,
    lifts: new Set(lifts.map(liftKey)),
    workoutCount: 12,
    lengthWeeks: 4,
    setOrder: new Map(lifts.map((lift) => [liftKey(lift), 'descending'])),
  });
  const a = custom('a', ['Squat', 'Bench Press', 'Face Pull']);
  const b = custom('b', ['Squat', 'Bench Press', 'Barbell Row']);
  const keys = (lifts: string[]) => new Set(lifts.map(liftKey));

  it('gives a tie to the Source program when it is one of the tied programs', () => {
    expect(matchProgramForKeys(keys(['Squat']), [a, b], 'b')).toEqual({ program: b, tiedWith: ['a'], bySetOrder: false });
  });

  it('gives a tie to the first program otherwise, naming the rest', () => {
    expect(matchProgramForKeys(keys(['Squat']), [a, b], 'rpt')).toEqual({ program: a, tiedWith: ['b'], bySetOrder: false });
    expect(matchProgramForLifts(['Squat'], [a, b])).toEqual({ program: a, tiedWith: ['b'], bySetOrder: false });
  });

  it('prefers the program whose set order agrees with the most sessions over the smallest', () => {
    // Squat and bench fit 5-3-1 (smallest) and RPT; descending sets agree only with RPT.
    const squatBench = keys(['Squat', 'Bench Press']);
    const match = matchProgramForKeys(squatBench, BUILT_IN_KNOWN_PROGRAMS, undefined, new Map([['rpt', 3]]));
    expect(match).toMatchObject({ program: { id: 'rpt' }, bySetOrder: true });
    expect(matchProgramForKeys(squatBench, BUILT_IN_KNOWN_PROGRAMS)?.program.id).toBe('5-3-1');
  });
});

describe('programNameKey', () => {
  it('drops Latin accents but keeps the vowel signs that tell words apart in other scripts', () => {
    expect(programNameKey('Leangáins')).toBe('leangains');
    expect(programNameKey('5/3/1')).toBe(programNameKey('5-3-1'));
    expect(programNameKey('बल')).not.toBe(programNameKey('बाल'));
    expect(programNameKey('शक्ति')).not.toBe(programNameKey('शक्त'));
    expect(programNameKey('-')).toBe('');
  });
});

describe('knownProgramFromSpec', () => {
  const row = { week: 1 as const, offset: 0 };

  it('reads each lift set order from its wtDecrementPct, unless the author order overrides it', () => {
    const spec = [
      { ...row, lift: 'Squat', wtDecrementPct: 0.1 },
      { ...row, lift: 'Leg Curl', wtDecrementPct: 0 },
    ];
    expect([...knownProgramFromSpec('x', spec).setOrder.values()]).toEqual(['descending', 'straight']);
    expect([...knownProgramFromSpec('x', spec, 'ascending').setOrder.values()]).toEqual(['ascending', 'straight']);
  });
});
