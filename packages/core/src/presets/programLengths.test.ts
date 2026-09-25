import {
  PRESET_BASE_SPECS,
  PROGRAM_LENGTHS,
  baseSpecBlockWeeks,
  blockWeekForProgramWeek,
  programLengthWeeks,
  expandSpecToLength,
  orderedWorkoutKeys,
  noScheduleWorkoutDateUTC,
  specRowsForWorkoutDay,
} from '.';
import { LiftingProgramSpec } from '../models/LiftingProgramSpec';

const makeRow = (
  overrides: Partial<LiftingProgramSpec> = {},
): LiftingProgramSpec => ({
  week: 1,
  offset: 0,
  lift: 'Squat',
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: true,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0.1,
  activation: 'compound',
  ...overrides,
});

// A synthetic 3-week block: 1 row per week, so tiling math is easy to assert.
const block3 = [
  makeRow({ week: 1, lift: 'A', reps: 5 }),
  makeRow({ week: 2, lift: 'A', reps: 3 }),
  makeRow({ week: 3, lift: 'A', reps: 1 }),
];

// A synthetic 1-week block with two rows (two lifts on one day).
const block1 = [
  makeRow({ week: 1, lift: 'A', offset: 0 }),
  makeRow({ week: 1, lift: 'B', offset: 2 }),
];

// ---------------------------------------------------------------------------
// PROGRAM_LENGTHS registry
// ---------------------------------------------------------------------------

describe('PROGRAM_LENGTHS', () => {
  it('advertises Leangains as a 12-week repeating (autoregulated) program', () => {
    expect(PROGRAM_LENGTHS['leangains']).toEqual({
      lengthWeeks: 12,
      blockWeeks: 1,
      phaseStyle: 'repeating',
    });
  });

  it('advertises RPT as an 8-week repeating program', () => {
    expect(PROGRAM_LENGTHS['rpt']).toEqual({
      lengthWeeks: 8,
      blockWeeks: 1,
      phaseStyle: 'repeating',
    });
  });

  it('advertises 5-3-1 as a 12-week structured (wave) program', () => {
    expect(PROGRAM_LENGTHS['5-3-1']).toEqual({
      lengthWeeks: 12,
      blockWeeks: 3,
      phaseStyle: 'wave',
    });
  });

  it('each registry blockWeeks matches its PRESET_BASE_SPECS block size', () => {
    for (const [program, meta] of Object.entries(PROGRAM_LENGTHS)) {
      const spec = PRESET_BASE_SPECS[program];
      expect(spec).toBeDefined();
      expect(baseSpecBlockWeeks(spec ?? [])).toBe(meta.blockWeeks);
    }
  });

  it('each registry lengthWeeks is a whole multiple of its blockWeeks', () => {
    // Tiling is cleanest when the program length is an exact number of blocks;
    // partial trailing blocks are supported but not intended for built-ins.
    for (const meta of Object.values(PROGRAM_LENGTHS)) {
      expect(meta.lengthWeeks % meta.blockWeeks).toBe(0);
    }
  });

  it('registers a canonical length for every seeded preset', () => {
    // Any program with a PRESET_BASE_SPECS entry is schedulable/planable, so it
    // must also have a canonical length here — otherwise programLengthWeeks silently
    // falls back to the block size and the advertised length collapses (issue #680).
    // This is the reciprocal guard: adding a preset without a length fails loudly.
    for (const program of Object.keys(PRESET_BASE_SPECS)) {
      expect(PROGRAM_LENGTHS[program]).toBeDefined();
    }
  });

  it('every wave program has a multi-week block', () => {
    // buildPhaseTemplate only renders per-wave phases when phaseStyle==='wave' AND
    // blockWeeks>1; a wave program with a 1-week block would silently degrade to a
    // single flat phase. Enforce the contract the plan renderer assumes.
    for (const meta of Object.values(PROGRAM_LENGTHS)) {
      if (meta.phaseStyle === 'wave') expect(meta.blockWeeks).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// baseSpecBlockWeeks
// ---------------------------------------------------------------------------

describe('baseSpecBlockWeeks', () => {
  it('returns 0 for an empty spec', () => {
    expect(baseSpecBlockWeeks([])).toBe(0);
  });

  it('returns the max week present in the block', () => {
    expect(baseSpecBlockWeeks(block1)).toBe(1);
    expect(baseSpecBlockWeeks(block3)).toBe(3);
  });

  it('matches the real Leangains (1) and 5-3-1 (3) presets', () => {
    expect(baseSpecBlockWeeks((PRESET_BASE_SPECS['leangains'] ?? []))).toBe(1);
    expect(baseSpecBlockWeeks((PRESET_BASE_SPECS['5-3-1'] ?? []))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// programLengthWeeks
// ---------------------------------------------------------------------------

describe('programLengthWeeks', () => {
  it('prefers the canonical registry length over the base-spec block size', () => {
    // Leangains preset is a 1-week block, but the canonical length is 12.
    expect(programLengthWeeks('leangains', (PRESET_BASE_SPECS['leangains'] ?? []))).toBe(12);
    expect(programLengthWeeks('rpt', (PRESET_BASE_SPECS['rpt'] ?? []))).toBe(8);
    expect(programLengthWeeks('5-3-1', (PRESET_BASE_SPECS['5-3-1'] ?? []))).toBe(12);
  });

  it('falls back to the base-spec block size for unregistered programs', () => {
    // Preserves the historical Math.max(...spec.week) behavior for custom programs.
    expect(programLengthWeeks('some-custom-uuid', block3)).toBe(3);
    expect(programLengthWeeks('some-custom-uuid', block1)).toBe(1);
  });

  it('returns 0 for an unregistered program with an empty spec', () => {
    expect(programLengthWeeks('unknown', [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// expandSpecToLength
// ---------------------------------------------------------------------------

describe('expandSpecToLength', () => {
  it('tiles a 1-week block across N weeks with contiguous week numbers', () => {
    const expanded = expandSpecToLength(block1, 12);
    const weeks = [...new Set(expanded.map((r) => r.week))];
    expect(weeks).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // Two rows per week × 12 weeks.
    expect(expanded).toHaveLength(24);
  });

  it('tiles a 3-week block across 12 weeks (4 waves)', () => {
    const expanded = expandSpecToLength(block3, 12);
    expect(expanded).toHaveLength(12); // 1 row/week × 12
    expect(expanded.map((r) => r.week)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });

  it('repeats block-week attributes at the tiled position', () => {
    const expanded = expandSpecToLength(block3, 12);
    // block week 1 = reps 5, week 2 = reps 3, week 3 = reps 1; repeated every 3.
    const repsByWeek = new Map(expanded.map((r) => [r.week, r.reps]));
    expect(repsByWeek.get(1)).toBe(5);
    expect(repsByWeek.get(4)).toBe(5); // wave 2, block week 1
    expect(repsByWeek.get(5)).toBe(3); // wave 2, block week 2
    expect(repsByWeek.get(12)).toBe(1); // wave 4, block week 3
  });

  it('includes a partial trailing block when length is not a whole multiple', () => {
    const expanded = expandSpecToLength(block3, 8);
    expect(expanded.map((r) => r.week)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const repsByWeek = new Map(expanded.map((r) => [r.week, r.reps]));
    expect(repsByWeek.get(7)).toBe(5); // block week 1
    expect(repsByWeek.get(8)).toBe(3); // block week 2 (block week 3 truncated away)
  });

  it('preserves all non-week row fields', () => {
    const expanded = expandSpecToLength(block1, 3);
    const first = expanded[0];
    expect(first).toMatchObject({
      lift: 'A',
      offset: 0,
      increment: 5,
      order: 1,
      sets: 3,
      warmUpPct: '0.4,0.5,0.6',
      wtDecrementPct: 0.1,
      activation: 'compound',
    });
  });

  it('is a no-op (returns the same shape) when length equals the block size', () => {
    const expanded = expandSpecToLength(block3, 3);
    expect(expanded.map((r) => ({ week: r.week, reps: r.reps }))).toEqual([
      { week: 1, reps: 5 },
      { week: 2, reps: 3 },
      { week: 3, reps: 1 },
    ]);
  });

  it('returns [] for an empty base spec (zero-spec guard)', () => {
    expect(expandSpecToLength([], 12)).toEqual([]);
  });

  it('returns [] for a non-positive length', () => {
    expect(expandSpecToLength(block1, 0)).toEqual([]);
    expect(expandSpecToLength(block1, -3)).toEqual([]);
  });

  it('does not mutate the input rows', () => {
    const input = [makeRow({ week: 1, lift: 'A' })];
    const snapshot = JSON.stringify(input);
    expandSpecToLength(input, 5);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('expands the real Leangains preset to a full 12-week schedule', () => {
    const base = (PRESET_BASE_SPECS['leangains'] ?? []);
    const expanded = expandSpecToLength(base, 12);
    expect(baseSpecBlockWeeks(expanded)).toBe(12);
    // Same rows per week as the 1-week block, tiled 12×.
    expect(expanded).toHaveLength(base.length * 12);
  });
});

// ---------------------------------------------------------------------------
// blockWeekForProgramWeek — inverse of expandSpecToLength's tiling (issue #740)
// ---------------------------------------------------------------------------

describe('blockWeekForProgramWeek', () => {
  it('maps a program week back into a 3-week block (5-3-1 waves)', () => {
    expect(blockWeekForProgramWeek(1, 3)).toBe(1);
    expect(blockWeekForProgramWeek(2, 3)).toBe(2);
    expect(blockWeekForProgramWeek(3, 3)).toBe(3);
    expect(blockWeekForProgramWeek(4, 3)).toBe(1); // wave 2, block week 1
    expect(blockWeekForProgramWeek(12, 3)).toBe(3);
  });

  it('is the identity for a 1-week repeating block', () => {
    expect(blockWeekForProgramWeek(1, 1)).toBe(1);
    expect(blockWeekForProgramWeek(12, 1)).toBe(1);
  });

  it('returns the program week unchanged when blockWeeks <= 0 (empty spec)', () => {
    expect(blockWeekForProgramWeek(5, 0)).toBe(5);
  });

  it('stays in lockstep with expandSpecToLength tiling', () => {
    // Every tiled row's program week must map back to the block week it came from
    // — this is the invariant the workouts controller relies on for planned lifts.
    // block3 encodes its block week in `reps` (wk1→5, wk2→3, wk3→1).
    const repsForBlockWeek: Record<number, number> = { 1: 5, 2: 3, 3: 1 };
    for (const row of expandSpecToLength(block3, 12)) {
      expect(row.reps).toBe(repsForBlockWeek[blockWeekForProgramWeek(row.week, 3)]);
    }
  });
});

// ---------------------------------------------------------------------------
// specRowsForWorkoutDay — one workout day's rows, through the block (issue #1014)
// ---------------------------------------------------------------------------

describe('specRowsForWorkoutDay', () => {
  // Two days of a 1-week block, stored the way custom-program rows come back:
  // by week, then order — so the days interleave.
  const twoDays = [
    makeRow({ offset: 0, lift: 'Bench Press', order: 1 }),
    makeRow({ offset: 2, lift: 'Squat', order: 1 }),
    makeRow({ offset: 0, lift: 'Barbell Row', order: 2 }),
    makeRow({ offset: 2, lift: 'Deadlift', order: 2 }),
  ];
  const lifts = (rows: LiftingProgramSpec[]) => rows.map((r) => r.lift);

  it('returns only the requested day’s rows, not the whole week', () => {
    expect(lifts(specRowsForWorkoutDay(twoDays, 1, 2))).toEqual(['Squat', 'Deadlift']);
  });

  it('maps a later program week back into the block', () => {
    // A 1-week block repeats every week; a 3-week block repeats every wave.
    expect(lifts(specRowsForWorkoutDay(twoDays, 9, 0))).toEqual(['Bench Press', 'Barbell Row']);
    // Program week 5 is the second wave's week 2 (block3 encodes it as reps 3).
    expect(specRowsForWorkoutDay(block3, 5, 0).map((r) => [r.week, r.reps])).toEqual([[2, 3]]);
  });

  it('orders the day by `order`, not by storage order', () => {
    expect(lifts(specRowsForWorkoutDay([...twoDays].reverse(), 1, 0))).toEqual([
      'Bench Press',
      'Barbell Row',
    ]);
  });

  it('returns [] for an offset the block week does not train, or an empty spec', () => {
    expect(specRowsForWorkoutDay(twoDays, 1, 4)).toEqual([]);
    expect(specRowsForWorkoutDay([], 1, 0)).toEqual([]);
  });

  it('does not mutate or reorder its input', () => {
    const input = [...twoDays].reverse();
    const before = [...input];
    specRowsForWorkoutDay(input, 1, 0);
    expect(input).toEqual(before);
  });

  it('agrees with the tiled spec on every workout day of every preset', () => {
    // The Cycle Dashboard groups the *tiled* spec by (week, offset); the API and
    // the web resolve a workout's day from the *stored* block. They must name the
    // same lifts with the same prescription on every day, or a card and the
    // workout it opens disagree (issues #740, #1014). Reps differ by week in
    // 5-3-1, so comparing them also pins the right block week.
    const liftsAndReps = (rows: LiftingProgramSpec[]) => rows.map((r) => [r.lift, r.reps]);
    for (const [program, base] of Object.entries(PRESET_BASE_SPECS)) {
      const tiled = expandSpecToLength(base, programLengthWeeks(program, base));
      const keys = orderedWorkoutKeys(tiled);
      expect(keys.length).toBeGreaterThan(0);
      for (const { week, offset } of keys) {
        const card = tiled
          .filter((r) => r.week === week && r.offset === offset)
          .sort((a, b) => a.order - b.order);
        expect(liftsAndReps(specRowsForWorkoutDay(base, week, offset))).toEqual(liftsAndReps(card));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// orderedWorkoutKeys — the shared workoutNum ↔ (week, offset) mapping (issue #740)
// ---------------------------------------------------------------------------

describe('orderedWorkoutKeys', () => {
  it('returns distinct (week, offset) keys ordered by week then offset', () => {
    // Rows deliberately out of order, with duplicate (week, offset) pairs and
    // multiple lifts sharing a workout day.
    const spec = [
      makeRow({ week: 2, offset: 3, lift: 'A' }),
      makeRow({ week: 1, offset: 3, lift: 'B' }),
      makeRow({ week: 1, offset: 0, lift: 'C' }),
      makeRow({ week: 1, offset: 0, lift: 'D' }), // duplicate key with row C
      makeRow({ week: 2, offset: 0, lift: 'E' }),
    ];
    expect(orderedWorkoutKeys(spec)).toEqual([
      { week: 1, offset: 0 },
      { week: 1, offset: 3 },
      { week: 2, offset: 0 },
      { week: 2, offset: 3 },
    ]);
  });

  it('returns [] for an empty spec', () => {
    expect(orderedWorkoutKeys([])).toEqual([]);
  });

  it('indexes workoutNum → (week, offset) consistently with a tiled Leangains block', () => {
    // Both the web grid (buildWorkoutDays) and the API (weekForWorkoutNum) call
    // orderedWorkoutKeys(expandSpecToLength(...)), so this is the single contract
    // that keeps a Dashboard card's workoutNum aligned with the workout it opens.
    const base = (PRESET_BASE_SPECS['leangains'] ?? []);
    const keys = orderedWorkoutKeys(expandSpecToLength(base, 12));
    expect(keys).toHaveLength(36); // 12 weeks × 3 offsets {0,2,4}
    expect(keys[0]).toEqual({ week: 1, offset: 0 });
    expect(keys[3]).toEqual({ week: 2, offset: 0 }); // workoutNum 4 → week 2
    expect(keys[35]?.week).toBe(12);
  });
});

describe('noScheduleWorkoutDateUTC', () => {
  const cycleStart = new Date('2026-04-20T00:00:00.000Z'); // a Monday, UTC midnight
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  it('week 1 is cycleStart + offset (no week term)', () => {
    expect(iso(noScheduleWorkoutDateUTC(cycleStart, 1, 0))).toBe('2026-04-20');
    expect(iso(noScheduleWorkoutDateUTC(cycleStart, 1, 2))).toBe('2026-04-22');
  });

  it('advances a full 7 days per program week: (week-1)*7 + offset', () => {
    expect(iso(noScheduleWorkoutDateUTC(cycleStart, 2, 0))).toBe('2026-04-27'); // +7
    expect(iso(noScheduleWorkoutDateUTC(cycleStart, 3, 4))).toBe('2026-05-08'); // +14+4
    expect(iso(noScheduleWorkoutDateUTC(cycleStart, 12, 0))).toBe('2026-07-06'); // +77
  });

  it('returns a fresh UTC-midnight Date and does not mutate the input', () => {
    const out = noScheduleWorkoutDateUTC(cycleStart, 2, 0);
    expect(out.getUTCHours()).toBe(0);
    expect(iso(cycleStart)).toBe('2026-04-20'); // input unchanged
  });

  it('is the date-side companion to orderedWorkoutKeys — one date per tiled workoutNum', () => {
    // buildWorkoutDays (web card) and toWorkoutResponse (API detail) both resolve a
    // workoutNum to its (week, offset) via orderedWorkoutKeys(expandSpecToLength(...))
    // then feed it to this helper, so this is the single contract that keeps a card's
    // date aligned with the workout it opens (issue #745).
    const base = PRESET_BASE_SPECS['leangains'] ?? [];
    const keys = orderedWorkoutKeys(expandSpecToLength(base, 12));
    expect(keys[3]).toEqual({ week: 2, offset: 0 }); // workoutNum 4 → week 2, offset 0
    // …and that (week, offset) yields the card/detail date cycleStart + 7.
    expect(iso(noScheduleWorkoutDateUTC(cycleStart, 2, 0))).toBe('2026-04-27');
  });
});
