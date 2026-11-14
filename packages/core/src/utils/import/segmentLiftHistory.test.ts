import { KnownProgram, knownProgramFromSpec, liftKey } from '../../presets';
import {
  classifySetOrder,
  fileMacrocycleKey,
  fileMacrocycleKeys,
  LiftHistoryRow,
  segmentLiftHistory,
  SegmentLiftHistoryOptions,
} from './segmentLiftHistory';

/** Day 0 is Monday 5 January 2026, UTC. */
const day = (n: number): Date => new Date(Date.UTC(2026, 0, 5 + n));

const RPT_DAYS = [
  ['Bench Press', 'Barbell Row', 'Overhead Press'],
  ['Squat', 'Romanian Deadlift', 'Calf Raises'],
  ['Deadlift', 'Weighted Pull-ups', 'Dips'],
];
const LEANGAINS_DAYS = [
  ['Bench Press', 'Weighted Pull-ups', 'Incline DB Press', 'Cable Row'],
  ['Squat', 'Romanian Deadlift', 'Leg Curl', 'Calf Raises'],
  ['Overhead Press', 'Deadlift', 'Lateral Raises', 'Dips'],
];
const FIVE_THREE_ONE_DAYS = [
  ['Squat', 'Bench Press'],
  ['Deadlift', 'Overhead Press'],
];

interface Row extends LiftHistoryRow {
  id: string;
}

type Extra = Partial<Pick<Row, 'program' | 'macrocycleNum' | 'workoutNum' | 'setNum' | 'weight'>>;

function session(dayNum: number, lifts: readonly string[], extra: Extra = {}): Row[] {
  return lifts.map((lift) => ({ id: `${dayNum}:${lift}`, date: day(dayNum), lift, ...extra }));
}

/** `count` sessions cycling through `days`, `spacing` days apart from `start`. */
function run(
  days: readonly (readonly string[])[],
  start: number,
  count: number,
  { spacing = 2, extra = () => ({}) }: { spacing?: number; extra?: (i: number) => Extra } = {},
): Row[] {
  return Array.from({ length: count }, (_, i) =>
    session(start + i * spacing, days[i % days.length] ?? [], extra(i)),
  ).flat();
}

const WEIGHTS = { descending: [100, 90, 80], ascending: [80, 90, 100], straight: [50, 50, 50] } as const;
/** Lifts the RPT preset prescribes as straight sets. */
const STRAIGHT_LIFTS = new Set(['Calf Raises']);

/** Each row becomes three sets: compounds in `order`, straight-set accessories at one weight. */
function withSets(rows: readonly Row[], order: 'ascending' | 'descending'): Row[] {
  return rows.flatMap((row) =>
    (STRAIGHT_LIFTS.has(row.lift) ? WEIGHTS.straight : WEIGHTS[order]).map((weight, i) => ({
      ...row,
      id: `${row.id}:${i + 1}`,
      setNum: i + 1,
      weight,
    })),
  );
}

const lastDay = (rows: readonly Row[]): number =>
  rows.reduce(
    (last, r) =>
      r.date && !Number.isNaN(r.date.getTime())
        ? Math.max(last, Math.round((r.date.getTime() - day(0).getTime()) / 86_400_000))
        : last,
    -Infinity,
  );

function segment(rows: Row[], options: Partial<SegmentLiftHistoryOptions> = {}) {
  return segmentLiftHistory(rows, {
    importDate: day(lastDay(rows) + 2),
    sourceProgram: 'rpt',
    ...options,
  });
}

/**
 * A scale test checks growth, not wall clock, which varies with the host: an input 4 times
 * larger costs about 4 times as much when linear and 16 when quadratic. The allowance absorbs
 * timer noise on a small input.
 */
const GROWTH_LIMIT = 10;
const GROWTH_ALLOWANCE_MS = 50;

/**
 * The best of two timings for each input, alternating sizes so both see the same load, and
 * the large input's last result.
 */
function timeGrowth(smallRows: Row[], largeRows: Row[]) {
  const timed = (rows: Row[]) => {
    const started = performance.now();
    const result = segment(rows);
    return { ms: performance.now() - started, result };
  };
  const small1 = timed(smallRows);
  const large1 = timed(largeRows);
  const small2 = timed(smallRows);
  const large2 = timed(largeRows);
  return { small: Math.min(small1.ms, small2.ms), large: Math.min(large1.ms, large2.ms), result: large2.result };
}

describe('segmentLiftHistory', () => {
  describe('gaps (decision 4)', () => {
    it.each([
      [13, 1],
      [14, 1],
      [15, 2],
    ])('a %i-day gap gives %i stretch(es)', (gap, stretches) => {
      const first = run(RPT_DAYS, 0, 3);
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + gap, 3)];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(stretches);
      if (stretches === 2) expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'gap', days: 15 });
    });
  });

  describe('an unfinished run (decisions 6 and 7)', () => {
    it('is abandoned when the next stretch is a restart', () => {
      const first = run(RPT_DAYS, 0, 5);
      const result = segment([...first, ...run(RPT_DAYS, lastDay(first) + 20, 5)]);
      expect(result.stretches.map((s) => s.status)).toEqual(['abandoned', 'in-progress']);
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-restart' });
    });

    it('is abandoned when the next stretch is a different program', () => {
      const first = run(RPT_DAYS, 0, 5);
      const result = segment([...first, ...run(LEANGAINS_DAYS, lastDay(first) + 2, 3)]);
      expect(result.stretches.map((s) => s.program)).toEqual(['rpt', 'leangains']);
      expect(result.stretches[0]?.status).toBe('abandoned');
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-different-program' });
    });

    it('is judged against the program the next stretch is a candidate for when that one is unmatched', () => {
      const first = run(FIVE_THREE_ONE_DAYS, 0, 6);
      const restart = run([['Squat', 'Bench Press', 'Face Pull'], ['Deadlift', 'Overhead Press']], lastDay(first) + 20, 6);
      const result = segment([...first, ...restart]);
      expect(result.stretches[1]).toMatchObject({ matched: false, candidateProgram: '5-3-1' });
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-restart' });
    });

    it('says when the next stretch has no program to compare', () => {
      const first = run(FIVE_THREE_ONE_DAYS, 0, 6);
      const rows = [...first, ...run([['Kettlebell Swing']], lastDay(first) + 20, 6)];
      const result = segment(rows, { sourceProgram: '5-3-1' });
      expect(result.stretches[0]?.status).toBe('abandoned');
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-unmatched' });
    });

    it("compares the next stretch's Program column before its lifts", () => {
      // GZCLP's main lifts are 5/3/1's, so by lifts it would read as a restart.
      const first = run(FIVE_THREE_ONE_DAYS, 0, 6, { extra: () => ({ program: '5/3/1' }) });
      const gzclp = segment([...first, ...run(FIVE_THREE_ONE_DAYS, lastDay(first) + 20, 6, { extra: () => ({ program: 'GZCLP' }) })]);
      expect(gzclp.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-different-program' });
      // A known program named over lifts it doesn't have is still that program.
      const rpt = run(RPT_DAYS, 0, 6, { extra: () => ({ program: 'RPT' }) });
      const named = segment([...rpt, ...run(RPT_DAYS, lastDay(rpt) + 20, 6, { extra: () => ({ program: '5/3/1' }) })]);
      expect(named.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-different-program' });
    });

    it('is in progress as the last stretch inside its expected length', () => {
      const result = segment(run(RPT_DAYS, 0, 6));
      expect(result.stretches[0]?.status).toBe('in-progress');
      expect(result.stretches[0]?.completedWorkouts).toBe(6);
      expect(result.stretches[0]?.expectedWorkouts).toBe(24);
    });

    it('is abandoned when its last session is more than 14 days before the import date', () => {
      const rows = run(RPT_DAYS, 0, 6);
      const at = (n: number) => segment(rows, { importDate: day(lastDay(rows) + n) }).stretches[0];
      expect(at(14)?.status).toBe('in-progress');
      expect(at(15)?.status).toBe('abandoned');
      expect(at(15)?.reasons.status).toEqual({ kind: 'last-session-stale', daysBeforeImport: 15 });
    });
  });

  describe('a restart (decision 7)', () => {
    it("is abandoned when a file's workout number falls back", () => {
      const first = run(RPT_DAYS, 0, 6, { extra: (i) => ({ workoutNum: i + 1 }) });
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + 2, 3, { extra: (i) => ({ workoutNum: i + 1 }) })];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'workout-number-fell-back', from: 6, to: 1 });
      expect(result.stretches[0]?.status).toBe('abandoned');
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-restart' });
    });

    it('still sees the fallback with a blank Workout # cell, which takes the number of the session above', () => {
      const numbered = (start: number) =>
        run(RPT_DAYS, start, 10, { extra: (i) => ({ workoutNum: i + 1 }) });
      const first = numbered(0);
      const rows = [...first, ...numbered(lastDay(first) + 2)].map((row, i) =>
        i === 4 ? { ...row, workoutNum: null } : row,
      );
      const result = segment(rows);
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'workout-number-fell-back', from: 10, to: 1 });
      expect(result.stretches[0]?.completedWorkouts).toBe(10);
    });

    it('numbers blank sessions from the one above, and counts up to the first number', () => {
      // Sessions numbered blank, blank, 3, blank, 5.
      const rows = run(RPT_DAYS, 0, 5, { extra: (i) => ({ workoutNum: i === 2 ? 3 : i === 4 ? 5 : null }) });
      const result = segment(rows);
      expect(result.stretches[0]?.sessions.map((s) => s.workoutNum)).toEqual([1, 2, 3, 3, 5]);
      expect(result.stretches[0]?.completedWorkouts).toBe(4);
    });

    it("counts up a restart's blank first workout rather than borrowing the last run's number", () => {
      const first = run(RPT_DAYS, 0, 10, { extra: (i) => ({ workoutNum: i + 1 }) });
      // After a 42-day break: blank, 2, 3, 4, 5.
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + 42, 5, { extra: (i) => ({ workoutNum: i === 0 ? null : i + 1 }) })];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'gap', days: 42 });
      expect(result.stretches[1]?.sessions.map((s) => s.workoutNum)).toEqual([1, 2, 3, 4, 5]);
      expect(result.stretches[1]?.completedWorkouts).toBe(5);
    });

    it('does the same after a finished run', () => {
      const first = run(FIVE_THREE_ONE_DAYS, 0, 24, { extra: (i) => ({ workoutNum: i + 1 }) });
      const rows = [...first, ...run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 4, { extra: (i) => ({ workoutNum: i === 0 ? null : i + 1 }) })];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'previous-run-finished' });
      expect(result.stretches[1]?.sessions.map((s) => s.workoutNum)).toEqual([1, 2, 3, 4]);
    });

    it('counts sessions for a stretch with no Workout # even when others in the file have one', () => {
      const unnumbered = run(FIVE_THREE_ONE_DAYS, 0, 24);
      const rows = [...unnumbered, ...run(FIVE_THREE_ONE_DAYS, lastDay(unnumbered) + 2, 3, { extra: (i) => ({ workoutNum: i + 1 }) })];
      const result = segment(rows);
      expect(result.stretches[0]).toMatchObject({ completedWorkouts: 24, status: 'completed' });
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'previous-run-finished' });
      expect(result.stretches[1]?.sessions.map((s) => s.workoutNum)).toEqual([1, 2, 3]);
    });

    it('continues the same stretch across a 10-day gap with no fallback', () => {
      const first = run(RPT_DAYS, 0, 4, { extra: (i) => ({ workoutNum: i + 1 }) });
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + 10, 3, { extra: (i) => ({ workoutNum: i + 5 }) })];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]?.completedWorkouts).toBe(7);
    });
  });

  describe('an overrun (decisions 6 and 7)', () => {
    // RPT runs 8 weeks (56 days) and 24 workouts. Ten sessions six days apart span 54 days.
    const slow = run(RPT_DAYS, 0, 10, { spacing: 6 });

    it('is overran past its expected length with workouts left', () => {
      const result = segment(slow, { importDate: day(58) });
      expect(result.stretches[0]?.status).toBe('overran');
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'past-expected-length', weeksSinceStart: 8 });
    });

    it('is completed when every workout was done, however late', () => {
      const late = run(RPT_DAYS, 0, 24, { spacing: 3 });
      expect(lastDay(late)).toBeGreaterThan(56);
      const result = segment(late);
      expect(result.stretches[0]?.status).toBe('completed');
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'all-workouts-done' });
    });

    it('is abandoned when the overrun is followed by a restart', () => {
      const result = segment([...slow, ...run(RPT_DAYS, lastDay(slow) + 20, 3)]);
      expect(result.stretches[0]?.status).toBe('abandoned');
    });
  });

  describe('a finished run (decision 6)', () => {
    it('starts a new stretch at the session after the last workout, with no gap', () => {
      const finished = run(FIVE_THREE_ONE_DAYS, 0, 24, { spacing: 3 });
      const result = segment([...finished, ...session(lastDay(finished) + 3, ['Squat', 'Bench Press'])], {
        sourceProgram: '5-3-1',
      });
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[0]?.status).toBe('completed');
      expect(result.stretches[0]?.sessions).toHaveLength(24);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'previous-run-finished' });
    });
  });

  describe('a program switch with no gap (decision 9)', () => {
    it('starts a new stretch where the Program column changes', () => {
      const first = run(RPT_DAYS, 0, 4, { extra: () => ({ program: 'rpt' }) });
      const rows = [...first, ...run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 4, { extra: () => ({ program: '5-3-1' }) })];
      const result = segment(rows);
      expect(result.stretches.map((s) => s.program)).toEqual(['rpt', '5-3-1']);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'program-column-changed', from: 'rpt', to: '5-3-1' });
    });

    it('starts a new stretch at a lift outside the current program', () => {
      const first = run(RPT_DAYS, 0, 4);
      const result = segment([...first, ...run(LEANGAINS_DAYS, lastDay(first) + 2, 3)]);
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[1]?.reasons.start).toEqual({
        kind: 'lift-outside-program',
        lifts: ['Incline DB Press', 'Cable Row'],
      });
    });

    it('does not split a Leangains run whose first sessions also fit RPT', () => {
      // The first session fits both RPT and Leangains; RPT, the smaller, is matched until Leg Curl
      // and the other Leangains-only lifts arrive, which narrows the match rather than splitting it.
      const result = segment([...session(0, ['Squat', 'Romanian Deadlift']), ...run(LEANGAINS_DAYS, 2, 6)]);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]?.program).toBe('leangains');
    });

    it('does not start one on a move to a subset program (RPT to 5/3/1) with no column', () => {
      const first = run(RPT_DAYS, 0, 4);
      const result = segment([...first, ...run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 4)]);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]?.program).toBe('rpt');
    });

    it('starts one on a move to a larger program (5/3/1 to RPT) once the first has held a week', () => {
      // 5/3/1 is 24 workouts over 12 weeks: two sessions settle it.
      const first = run(FIVE_THREE_ONE_DAYS, 0, 4);
      const result = segment([...first, ...run(RPT_DAYS, lastDay(first) + 2, 3)], { sourceProgram: '5-3-1' });
      expect(result.stretches.map((s) => s.program)).toEqual(['5-3-1', 'rpt']);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'lift-outside-program', lifts: ['Barbell Row'] });
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'next-is-different-program' });
    });

    it('does not compare spellings of one program in the Program column', () => {
      const first = run(FIVE_THREE_ONE_DAYS, 0, 3, { extra: () => ({ program: '5/3/1' }) });
      const rows = [...first, ...run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 3, { extra: () => ({ program: '5-3-1' }) })];
      expect(segment(rows).stretches).toHaveLength(1);
      const custom = run([['Zercher Squat']], 0, 2, { extra: () => ({ program: 'My Plan' }) });
      const more = run([['Zercher Squat']], lastDay(custom) + 2, 2, { extra: () => ({ program: 'my-plan' }) });
      expect(segment([...custom, ...more]).stretches).toHaveLength(1);
    });

    it('starts one where a Program value first appears and names a program the lifts so far are not in', () => {
      const first = run(RPT_DAYS, 0, 4);
      const rows = [...first, ...run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 4, { extra: () => ({ program: '5-3-1' }) })];
      const result = segment(rows);
      expect(result.stretches.map((s) => s.program)).toEqual(['rpt', '5-3-1']);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'program-column-changed', from: null, to: '5-3-1' });
    });

    it('splits off a first session whose lifts no one program contains', () => {
      // Barbell Row is RPT-only and Incline DB Press Leangains-only: a transition day.
      const rpt = run(RPT_DAYS, 2, 24);
      const rows = [
        ...session(0, ['Barbell Row', 'Incline DB Press']),
        ...rpt,
        ...run(FIVE_THREE_ONE_DAYS, lastDay(rpt) + 2, 24),
      ];
      const result = segment(rows);
      expect(result.stretches.map((s) => [s.program, s.matched, s.sessions.length])).toEqual([
        ['rpt', false, 1],
        ['rpt', true, 24],
        ['5-3-1', true, 24],
      ]);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'previous-fits-no-program' });
      expect(result.stretches[2]?.reasons.start).toEqual({ kind: 'previous-run-finished' });
    });

    it('splits off a transition session before the run before it has settled', () => {
      // RPT's legs and pull days also fit Leangains; then a day mixing RPT and Leangains lifts.
      const before = run([RPT_DAYS[1] ?? [], RPT_DAYS[2] ?? []], 0, 2);
      const rows = [
        ...before,
        ...session(lastDay(before) + 2, ['Bench Press', 'Barbell Row', 'Incline DB Press']),
        ...run(RPT_DAYS, lastDay(before) + 4, 6),
      ];
      const result = segment(rows);
      expect(result.stretches.map((s) => [s.matched, s.sessions.length, s.reasons.start.kind])).toEqual([
        [true, 2, 'first-session'],
        [false, 1, 'lift-outside-program'],
        [true, 6, 'previous-fits-no-program'],
      ]);
    });

    it('starts one where a Program value naming no known program first appears in a matched run', () => {
      const first = run(RPT_DAYS, 0, 6);
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + 2, 6, { extra: () => ({ program: 'GZCLP' }) })];
      const result = segment(rows);
      expect(result.stretches.map((s) => [s.program, s.matched])).toEqual([
        ['rpt', true],
        ['rpt', false],
      ]);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'program-column-changed', from: null, to: 'GZCLP' });
    });

    it("reads a Program cell naming a custom program with no lifts yet as unknown", () => {
      const empty: KnownProgram = { ...knownProgramFromSpec('custom-1', []), name: 'My Plan' };
      const result = segment(run(RPT_DAYS, 0, 5, { extra: () => ({ program: 'My Plan' }) }), { customPrograms: [empty] });
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]).toMatchObject({ matched: false, candidateProgram: 'rpt' });
    });

    it('tells apart names in scripts whose vowel signs are combining marks', () => {
      const first = run(RPT_DAYS, 0, 6, { extra: () => ({ program: 'बल' }) });
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + 2, 6, { extra: () => ({ program: 'बाल' }) })];
      expect(segment(rows).stretches[1]?.reasons.start).toEqual({ kind: 'program-column-changed', from: 'बल', to: 'बाल' });
    });

    it('compares Program cells in any script, and reads a cell of only punctuation as blank', () => {
      // Both runs are RPT's lifts, so only the labels tell them apart.
      const first = run(RPT_DAYS, 0, 6, { extra: () => ({ program: 'Сила' }) });
      const labelled = [...first, ...run(RPT_DAYS, lastDay(first) + 2, 6, { extra: () => ({ program: 'Масса' }) })];
      expect(segment(labelled).stretches[1]?.reasons.start).toEqual({
        kind: 'program-column-changed',
        from: 'Сила',
        to: 'Масса',
      });
      const leangains = run(LEANGAINS_DAYS, 0, 6);
      const dashed = [...leangains, ...run(RPT_DAYS, lastDay(leangains) + 2, 6)].map((row) => ({ ...row, program: '-' }));
      const result = segment(dashed);
      expect(result.stretches.map((s) => s.program)).toEqual(['leangains', 'rpt']);
      expect(result.stretches[1]?.reasons.start.kind).toBe('lift-outside-program');
    });

    it('keeps a stretch labelled with an unknown program whole and unmatched, offering its lifts as the candidate', () => {
      const result = segment(run(FIVE_THREE_ONE_DAYS, 0, 30, { extra: () => ({ program: 'GZCLP' }) }));
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]).toMatchObject({
        program: 'rpt',
        matched: false,
        status: null,
        candidateProgram: '5-3-1',
        liftsOutsideProgram: [],
      });
      expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'column', value: 'GZCLP' });
    });

    it('continues where a Program value first appears and names the program the lifts are in', () => {
      const first = run(RPT_DAYS, 0, 2);
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + 2, 2, { extra: () => ({ program: 'RPT' }) })];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'column', value: 'RPT' });
    });
  });

  describe('set order', () => {
    it.each([
      [[100, 90, 80], 'descending'],
      [[80, 90, 100], 'ascending'],
      [[50, 50, 50], 'straight'],
      // Warm-ups, then straight sets at the top weight.
      [[90, 100, 100], 'straight'],
      [[95, 135, 185, 225, 225, 225], 'straight'],
      // Warm-ups, then a reverse pyramid: every set after the top is lighter than the last.
      [[60, 100, 90, 80], 'descending'],
      // 5/3/1's climb, then back-off sets that level off (Boring But Big, First Set Last).
      [[135, 155, 175, 135, 135, 135], 'ascending'],
      [[100], null],
    ])('reads %j as %s', (weights, order) => {
      expect(classifySetOrder(weights)).toBe(order);
    });

    it('reads a session too large to spread into one call', () => {
      expect(classifySetOrder(Array.from({ length: 200_000 }, (_, i) => 200_000 - i))).toBe('descending');
    });

    it('matches 5/3/1 with back-off sets, not RPT', () => {
      const rows = run(FIVE_THREE_ONE_DAYS, 0, 8).flatMap((row) =>
        [135, 155, 175, 135, 135, 135].map((weight, i) => ({ ...row, id: `${row.id}:${i}`, setNum: i + 1, weight })),
      );
      expect(segment(rows).stretches[0]?.program).toBe('5-3-1');
    });

    it('starts a new stretch where a settled set order turns around (RPT to 5/3/1, no column)', () => {
      const first = withSets(run(RPT_DAYS, 0, 4), 'descending');
      const rows = [...first, ...withSets(run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 4), 'ascending')];
      const result = segment(rows);
      expect(result.stretches.map((s) => s.program)).toEqual(['rpt', '5-3-1']);
      expect(result.stretches[1]?.reasons.start).toEqual({
        kind: 'set-order-changed',
        lifts: [
          { lift: 'Squat', from: 'descending', to: 'ascending' },
          { lift: 'Bench Press', from: 'descending', to: 'ascending' },
        ],
      });
      expect(result.stretches[1]?.reasons.program).toEqual({ kind: 'lifts', tiedWith: [], bySetOrder: true });
      expect(result.stretches[0]?.status).toBe('abandoned');
    });

    it('does not split a run at one session whose sets run the other way', () => {
      const first = withSets(run(RPT_DAYS, 0, 4), 'descending');
      const odd = withSets(session(lastDay(first) + 2, ['Squat', 'Bench Press']), 'ascending');
      const rows = [...first, ...odd, ...withSets(run(RPT_DAYS, lastDay(first) + 4, 3), 'descending')];
      expect(segment(rows).stretches).toHaveLength(1);
    });

    it('matches the program whose order the sessions follow before the smallest', () => {
      const descending = segment(withSets(run(FIVE_THREE_ONE_DAYS, 0, 4), 'descending')).stretches[0];
      expect(descending?.program).toBe('rpt');
      expect(descending?.reasons.program).toEqual({ kind: 'lifts', tiedWith: [], bySetOrder: true });
      expect(segment(withSets(run(FIVE_THREE_ONE_DAYS, 0, 4), 'ascending')).stretches[0]?.program).toBe('5-3-1');
    });
  });

  describe('program precedence (decision 9)', () => {
    it("takes the file's column over the lifts, unmatched when its lifts are not all in it", () => {
      const result = segment(run(RPT_DAYS, 0, 3, { extra: () => ({ program: '5/3/1' }) }));
      expect(result.stretches[0]).toMatchObject({ program: '5-3-1', matched: false, status: null });
      expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'column', value: '5/3/1' });
      expect(result.stretches[0]?.liftsOutsideProgram).toEqual([
        'Barbell Row',
        'Romanian Deadlift',
        'Calf Raises',
        'Weighted Pull-ups',
        'Dips',
      ]);
      expect(result.stretches[0]?.candidateProgram).toBeUndefined();
    });

    it('takes the lifts over the Source program', () => {
      const result = segment(run(RPT_DAYS, 0, 3), { sourceProgram: '5-3-1' });
      expect(result.stretches[0]?.program).toBe('rpt');
      expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'lifts', tiedWith: [], bySetOrder: false });
    });

    describe('a tie', () => {
      const custom = (id: string, lifts: string[]): KnownProgram => ({
        id,
        name: id,
        lifts: new Set(lifts.map(liftKey)),
        workoutCount: 12,
        lengthWeeks: 4,
        setOrder: new Map(lifts.map((lift) => [liftKey(lift), 'descending'])),
      });
      const customPrograms = [
        custom('zeta', ['Squat', 'Bench Press', 'Barbell Row']),
        custom('alpha', ['Squat', 'Bench Press', 'Face Pull']),
      ];
      const rows = run([['Squat', 'Bench Press']], 0, 3);

      it('goes to the Source program', () => {
        const result = segment(rows, { customPrograms, sourceProgram: 'zeta' });
        expect(result.stretches[0]?.program).toBe('zeta');
        expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'lifts', tiedWith: ['alpha'], bySetOrder: false });
      });

      it('goes to the first program by name when the Source program is not tied, naming the rest', () => {
        const result = segment(rows, { customPrograms, sourceProgram: 'rpt' });
        expect(result.stretches[0]?.program).toBe('alpha');
        expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'lifts', tiedWith: ['zeta'], bySetOrder: false });
      });
    });
  });

  describe('a custom program', () => {
    // One repeating one-week block of three days, as the lifter wrote it.
    const block = ['Kettlebell Swing', 'Goblet Squat', 'Farmer Carry'].map((lift, offset) => ({ week: 1 as const, offset: offset * 2, lift }));
    const kbPlan: KnownProgram = { ...knownProgramFromSpec('custom-kb', block), name: 'KB Plan' };
    const kbDays = block.map((row) => [row.lift]);

    it('is open-ended: a run never finishes or overruns by length', () => {
      expect(kbPlan.workoutCount).toBe(3);
      const result = segment(run(kbDays, 0, 30), { customPrograms: [kbPlan] });
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]).toMatchObject({
        program: 'custom-kb',
        matched: true,
        status: 'in-progress',
        expectedWorkouts: null,
        completedWorkouts: 30,
      });
      expect(result.stretches[0]?.reasons.status).toEqual({ kind: 'open-ended' });
    });

    it('is named by a Program cell holding the name the caller gives it', () => {
      const result = segment(run(kbDays, 0, 6, { extra: () => ({ program: 'kb plan' }) }), { customPrograms: [kbPlan] });
      expect(result.stretches[0]?.program).toBe('custom-kb');
      expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'column', value: 'kb plan' });
    });
  });

  describe('workout numbering (decisions 6 and 9)', () => {
    it("keeps a file's numbers", () => {
      const result = segment(run(RPT_DAYS, 0, 3, { extra: (i) => ({ workoutNum: i + 3 }) }));
      expect(result.stretches[0]?.sessions.map((s) => s.workoutNum)).toEqual([3, 4, 5]);
    });

    it('numbers sessions in order without them', () => {
      const result = segment(run(RPT_DAYS, 0, 3));
      expect(result.stretches[0]?.sessions.map((s) => s.workoutNum)).toEqual([1, 2, 3]);
    });

    it('counts distinct file numbers as completed workouts when present', () => {
      // Workout 1 split over two days, workout 2 likewise.
      const nums = [1, 1, 2, 2];
      const result = segment(run(RPT_DAYS, 0, 4, { extra: (i) => ({ workoutNum: nums[i] ?? 0 }) }));
      expect(result.stretches[0]?.sessions).toHaveLength(4);
      expect(result.stretches[0]?.completedWorkouts).toBe(2);
    });
  });

  describe('a lone session in a gap (decision 5)', () => {
    const before = run(RPT_DAYS, 0, 3);
    const end = lastDay(before);
    const stretchDates = (result: ReturnType<typeof segment>) =>
      result.stretches.flatMap((s) => s.sessions.map((x) => x.date.getTime()));

    it('is flagged, outside every stretch, when it hides a break', () => {
      const rows = [...before, ...session(end + 10, ['Squat']), ...run(RPT_DAYS, end + 20, 3)];
      const result = segment(rows);
      expect(result.lone).toHaveLength(1);
      expect(result.lone[0]).toMatchObject({ daysAfterPrevious: 10, daysBeforeNext: 10 });
      expect(stretchDates(result)).not.toContain(day(end + 10).getTime());
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[1]?.reasons.start).toEqual({ kind: 'gap', days: 20 });
    });

    it('is flagged when the gaps on both sides are over 14 days', () => {
      const rows = [...before, ...session(end + 20, ['Squat']), ...run(RPT_DAYS, end + 40, 3)];
      const result = segment(rows);
      expect(result.lone).toHaveLength(1);
      expect(result.lone[0]).toMatchObject({ daysAfterPrevious: 20, daysBeforeNext: 20 });
      expect(stretchDates(result)).not.toContain(day(end + 20).getTime());
    });

    it('is flagged at the start of the file when its one neighbour is over 14 days away', () => {
      const result = segment([...session(0, ['Squat']), ...run(RPT_DAYS, 20, 3)]);
      expect(result.lone).toHaveLength(1);
      expect(result.lone[0]).toMatchObject({ daysAfterPrevious: null, daysBeforeNext: 20 });
    });

    it('stays with the run it is next to when only one side is over 14 days', () => {
      const rows = [...before, ...session(end + 2, ['Squat']), ...run(RPT_DAYS, end + 22, 3)];
      const result = segment(rows);
      expect(result.lone).toEqual([]);
      expect(result.stretches[0]?.endDate).toEqual(day(end + 2));
    });
  });

  describe('date-less rows', () => {
    it('are returned as unplaced and never guessed into a stretch', () => {
      const dated = run(RPT_DAYS, 0, 3);
      const undated: Row[] = [
        { id: 'a', date: null, lift: 'Squat' },
        { id: 'b', lift: 'Squat' },
        { id: 'c', date: new Date('not a date'), lift: 'Squat' },
      ];
      const result = segment([...dated.slice(0, 3), ...undated, ...dated.slice(3)]);
      expect(result.unplaced.map((r) => r.id)).toEqual(['a', 'b', 'c']);
      const placed = result.stretches.flatMap((s) => s.sessions.flatMap((x) => x.rows.map((r) => r.id)));
      expect(placed).toHaveLength(dated.length);
      expect(placed).not.toEqual(expect.arrayContaining(['a']));
    });
  });

  describe('non-cycle rows (decision 23, #1184)', () => {
    it('are returned on their own and never count as a session', () => {
      const before = run(RPT_DAYS, 0, 3);
      const after = run(RPT_DAYS, 50, 3);
      // Alone in the gap, with more than 14 days on each side, it would be a lone session.
      const nonCycle = session(25, ['Squat', 'Bench Press'], { program: 'non-cycle' });
      // Inside the first run, on a day of its own, it would be a session of that run.
      const inside = session(1, ['Deadlift'], { program: ' Non-Cycle ' });
      const result = segment([...before.slice(0, 3), ...inside, ...before.slice(3), ...nonCycle, ...after]);
      expect(result.nonCycle.map((r) => r.id)).toEqual([...inside, ...nonCycle].map((r) => r.id));
      expect(result.lone).toEqual([]);
      expect(result.stretches.map((s) => s.sessions.map((x) => x.date))).toEqual([
        [day(0), day(2), day(4)],
        [day(50), day(52), day(54)],
      ]);
    });

    it('are left out of a file numbered by macrocycle too', () => {
      const numbered = run(RPT_DAYS, 0, 3, { extra: (i) => ({ macrocycleNum: 1, workoutNum: i + 1 }) });
      const nonCycle = session(1, ['Squat'], { program: 'non-cycle', macrocycleNum: 1, workoutNum: 7 });
      const result = segment([...numbered, ...nonCycle]);
      expect(result.nonCycle.map((r) => r.id)).toEqual(nonCycle.map((r) => r.id));
      expect(result.stretches.flatMap((s) => s.sessions.map((x) => x.date))).toEqual([day(0), day(2), day(4)]);
    });
  });

  describe('an unmatched program (decision 9)', () => {
    it('numbers workouts in session order and suggests no status', () => {
      const rows = run([['Zercher Squat', 'Sled Push'], ['Landmine Press']], 0, 4);
      const result = segment(rows, { sourceProgram: '5-3-1' });
      const [stretch] = result.stretches;
      expect(stretch).toMatchObject({ program: '5-3-1', matched: false, status: null, expectedWorkouts: null });
      expect(stretch?.reasons.status).toEqual({ kind: 'unmatched' });
      expect(stretch?.sessions.map((s) => s.workoutNum)).toEqual([1, 2, 3, 4]);
    });

    it('keeps a run with a lift outside every program whole, and names the lift for the lifter to confirm', () => {
      const rows = [...run(RPT_DAYS, 0, 3), ...session(6, ['Bench Press', 'Face Pull']), ...run(RPT_DAYS, 8, 3)];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]).toMatchObject({
        program: 'rpt',
        matched: false,
        status: null,
        candidateProgram: 'rpt',
        liftsOutsideProgram: ['Face Pull'],
      });
    });

    it('names the column program as the candidate when only a lift in no known program is outside it', () => {
      const rows = [...run(RPT_DAYS, 0, 3), ...session(6, ['Bench Press', 'Face Pull'])].map((row) => ({
        ...row,
        program: 'RPT',
      }));
      expect(segment(rows).stretches[0]).toMatchObject({
        program: 'rpt',
        matched: false,
        candidateProgram: 'rpt',
        liftsOutsideProgram: ['Face Pull'],
      });
    });
  });

  it('grows linearly over 20,000 sessions of a lift in no known program', () => {
    // The quadratic version took 5.7 s at 20,000 sessions; the linear one about 0.2 s.
    const rowsFor = (sessions: number) =>
      Array.from({ length: sessions }, (_, i): Row => ({ id: `${i}`, date: day(i), lift: 'Zercher Squat' }));
    const { small, large, result } = timeGrowth(rowsFor(5_000), rowsFor(20_000));
    expect(large).toBeLessThan(GROWTH_LIMIT * small + GROWTH_ALLOWANCE_MS);
    expect(result.stretches).toHaveLength(1);
  });

  describe('at the scale of a real file', () => {
    // About 5,000 rows: 300 RPT sessions then 400 5/3/1 sessions, three weighed sets per lift.
    const history = (fileNumbers: boolean) => {
      const rpt = withSets(run(RPT_DAYS, 0, 300), 'descending');
      const fiveThreeOne = withSets(run(FIVE_THREE_ONE_DAYS, lastDay(rpt) + 2, 400), 'ascending');
      const rows = [...rpt, ...fiveThreeOne];
      if (!fileNumbers) return rows;
      const sessionOf = (row: Row) => Math.round(((row.date?.getTime() ?? 0) - day(0).getTime()) / 172_800_000);
      return rows.map((row) => ({
        ...row,
        macrocycleNum: Math.floor(sessionOf(row) / 24) + 1,
        workoutNum: (sessionOf(row) % 24) + 1,
      }));
    };

    it.each([
      ['by dates', false],
      ['by file numbers', true],
    ])('segments %s in well under 3 seconds', (_, fileNumbers) => {
      const rows = history(fileNumbers);
      expect(rows.length).toBeGreaterThan(4_500);
      const started = Date.now();
      const result = segment(rows);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(new Set(result.stretches.map((s) => s.program))).toEqual(new Set(['rpt', '5-3-1']));
    });

    it('grows linearly on one long stretch of known lifts with set weights', () => {
      // An unknown label keeps it one stretch, so matching and the set-order tallies run on
      // one long draft.
      const rowsFor = (sessions: number) =>
        withSets(run(RPT_DAYS, 0, sessions, { spacing: 1, extra: () => ({ program: 'GZCLP' }) }), 'descending');
      const { small, large, result } = timeGrowth(rowsFor(4_000), rowsFor(16_000));
      expect(large).toBeLessThan(GROWTH_LIMIT * small + GROWTH_ALLOWANCE_MS);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]?.candidateProgram).toBe('rpt');
    });

    it('grows linearly when every file number has its own Program label', () => {
      // "Block 1", "Block 2", …: one session each, so there are as many program groups as stretches.
      const rowsFor = (numbers: number) =>
        run(RPT_DAYS, 0, numbers, { spacing: 1, extra: (i) => ({ program: `Block ${i + 1}`, macrocycleNum: i + 1 }) });
      const { small, large, result } = timeGrowth(rowsFor(3_000), rowsFor(12_000));
      expect(large).toBeLessThan(GROWTH_LIMIT * small + GROWTH_ALLOWANCE_MS);
      expect(result.stretches).toHaveLength(12_000);
      expect(result.conflicts).toEqual([]);
    });

    it('survives every row on one day', () => {
      const rows = Array.from({ length: 150_000 }, (_, i): Row => ({
        id: `${i}`,
        date: day(0),
        lift: 'Squat',
        setNum: i + 1,
        weight: 100,
        workoutNum: 1,
      }));
      expect(segment(rows).stretches).toHaveLength(1);
    });
  });

  describe("a file's macrocycle numbers (decision 8)", () => {
    it('keeps its groupings and flags a break inside one number, without lone flags', () => {
      const first = run(RPT_DAYS, 0, 3, { extra: () => ({ macrocycleNum: 1 }) });
      const end = lastDay(first);
      const rows = [
        ...first,
        // In date mode this session would be lone: it hides the 20-day break on either side of it.
        ...session(end + 10, ['Squat'], { macrocycleNum: 1 }),
        ...run(RPT_DAYS, end + 20, 3, { extra: () => ({ macrocycleNum: 1 }) }),
      ];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]).toMatchObject({ fileMacrocycleNum: 1, reasons: { start: { kind: 'file-macrocycle', macrocycleNum: 1 } } });
      expect(result.stretches[0]?.sessions).toHaveLength(7);
      expect(result.lone).toEqual([]);
      expect(result.conflicts).toEqual([
        { kind: 'gap-inside-number', stretch: 0, from: day(end), to: day(end + 20), days: 20 },
      ]);
    });

    it('gives a blank number the one above it, and leaves rows with none to take unnumbered', () => {
      // Numbers only on each group's first row, as a sheet often has them.
      const lead = session(0, ['Squat']);
      const first = run(RPT_DAYS, 2, 3, { extra: (i) => (i === 0 ? { macrocycleNum: 1 } : {}) });
      const second = run(RPT_DAYS, lastDay(first) + 2, 3, { extra: (i) => (i === 0 ? { macrocycleNum: 2 } : {}) });
      const result = segment([...lead, ...first, ...second]);
      expect(result.stretches.map((s) => [s.fileMacrocycleNum, s.sessions.length])).toEqual([
        [1, 3],
        [2, 3],
      ]);
      expect(result.unnumbered.map((r) => r.id)).toEqual(['0:Squat']);
    });

    it('takes a blank number only from a row in the same program', () => {
      const first = run(RPT_DAYS, 0, 2, { extra: () => ({ program: 'rpt', macrocycleNum: 1 }) });
      const other = run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 2, { extra: () => ({ program: '5-3-1' }) });
      const result = segment([...first, ...other]);
      expect(result.stretches).toHaveLength(1);
      expect(result.unnumbered).toHaveLength(other.length);
    });

    it("keeps one number together across spellings and blank Program cells", () => {
      // "5/3/1", then "5-3-1", then a blank cell, then "5-3-1" again.
      const rows = run(FIVE_THREE_ONE_DAYS, 0, 4, {
        extra: (i) => ({ macrocycleNum: 1, program: i === 0 ? '5/3/1' : i === 2 ? null : '5-3-1' }),
      });
      const result = segment(rows);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]?.program).toBe('5-3-1');
      expect(result.conflicts).toEqual([]);
    });

    it("gives a session's leading blank number its session's number, from the same program (#1256)", () => {
      // The number is on the session's second row only; a 5-3-1 row that day has none to take.
      const rows = [
        ...session(0, ['Squat'], { program: '5-3-1' }),
        ...session(0, ['Calf Raises'], { program: 'rpt' }),
        ...session(0, ['Squat'], { program: 'rpt', macrocycleNum: 1 }),
        ...run(RPT_DAYS, 2, 2, { extra: () => ({ program: 'rpt', macrocycleNum: 1 }) }),
      ];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]?.sessions[0]?.rows.map((r) => r.lift)).toEqual(['Calf Raises', 'Squat']);
      expect(result.unnumbered.map((r) => r.lift)).toEqual(['Squat']);
      expect(result.unnumbered[0]?.program).toBe('5-3-1');
    });

    it("places an unnumbered row with its day's macrocycle, in file order, when placing by date (#1256)", () => {
      // Barbell Row has no number to take and isn't a 5/3/1 lift; a row on a day with none stays out.
      const rows = [
        ...session(0, ['Barbell Row'], { program: 'rpt' }),
        ...run(FIVE_THREE_ONE_DAYS, 0, 3, { extra: () => ({ program: '5-3-1', macrocycleNum: 1 }) }),
        ...session(1, ['Dips'], { program: 'rpt' }),
      ];
      const placed = segment(rows, { placeByDate: true });
      expect(placed.unnumbered.map((r) => r.lift)).toEqual(['Dips']);
      expect(placed.stretches).toHaveLength(1);
      expect(placed.stretches[0]?.sessions[0]?.rows.map((r) => r.lift)).toEqual(['Barbell Row', 'Squat', 'Bench Press']);
      expect(placed.stretches[0]).toMatchObject({ matched: false, liftsOutsideProgram: ['Barbell Row'] });

      const listed = segment(rows);
      expect(listed.unnumbered.map((r) => r.lift)).toEqual(['Barbell Row', 'Dips']);
      expect(listed.stretches[0]?.matched).toBe(true);
    });

    it("keys each row by the file macrocycle it's grouped in, across spellings and blank cells (#1256)", () => {
      const rows = [
        ...session(0, ['Squat'], { program: '5-3-1' }),
        ...run(FIVE_THREE_ONE_DAYS, 2, 3, {
          extra: (i) => ({ macrocycleNum: 1, program: i === 0 ? '5/3/1' : i === 1 ? null : '5-3-1' }),
        }),
      ];
      const options = { importDate: day(lastDay(rows) + 2), sourceProgram: 'rpt' };
      const [only] = segmentLiftHistory(rows, options).stretches;
      expect(only).toMatchObject({ fileMacrocycleNum: 1, fileGroup: '5-3-1' });
      const keys = fileMacrocycleKeys(rows, options);
      expect(keys[0]).toBeUndefined();
      expect(new Set(keys.slice(1))).toEqual(new Set([fileMacrocycleKey('5-3-1', 1)]));
    });

    it('flags two numbers in one program whose dates interleave', () => {
      const rows = [
        ...run(RPT_DAYS, 0, 4, { spacing: 4, extra: () => ({ macrocycleNum: 1 }) }),
        ...run(RPT_DAYS, 2, 4, { spacing: 4, extra: () => ({ macrocycleNum: 2 }) }),
      ];
      const result = segment(rows);
      expect(result.stretches.map((s) => s.fileMacrocycleNum)).toEqual([1, 2]);
      expect(result.conflicts).toEqual([{ kind: 'numbers-overlap', stretches: [0, 1] }]);
      // Overlapping by 10 days, number 2 runs alongside number 1 rather than restarting it.
      expect(result.stretches[0]?.status).toBe('in-progress');
    });

    it('reads a restart of the same program overlapping by a day as following it', () => {
      const first = run(RPT_DAYS, 0, 6, { extra: () => ({ macrocycleNum: 1 }) });
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) - 1, 5, { extra: () => ({ macrocycleNum: 2 }) })];
      expect(segment(rows).stretches[0]?.reasons.status).toEqual({ kind: 'next-is-restart' });
    });

    it('does not flag two different programs whose numbers run at the same time, nor end one early', () => {
      const rows = [
        ...run(FIVE_THREE_ONE_DAYS, 0, 6, { spacing: 4, extra: () => ({ program: '5/3/1', macrocycleNum: 1 }) }),
        ...run(RPT_DAYS, 1, 6, { spacing: 4, extra: () => ({ program: 'RPT', macrocycleNum: 1 }) }),
        ...run([['Kettlebell Swing']], 2, 6, { spacing: 4, extra: () => ({ program: 'Kettlebells', macrocycleNum: 1 }) }),
        ...run([['Rowing Machine']], 3, 6, { spacing: 4, extra: () => ({ program: 'Conditioning', macrocycleNum: 1 }) }),
      ];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(4);
      expect(result.conflicts).toEqual([]);
      // Nothing starts after the 5/3/1 number ends, so it is judged against the import date.
      expect(result.stretches[0]?.status).toBe('in-progress');
    });

    it("does not take another program's later number as what follows one still running", () => {
      const rows = [
        ...run(FIVE_THREE_ONE_DAYS, 0, 14, { spacing: 3, extra: () => ({ program: '5/3/1', macrocycleNum: 1 }) }),
        ...run([['Rowing Machine']], 1, 7, { spacing: 3, extra: () => ({ program: 'Conditioning', macrocycleNum: 1 }) }),
        ...session(41, ['Rowing Machine'], { program: 'Conditioning', macrocycleNum: 2 }),
      ];
      const result = segment(rows, { importDate: day(42) });
      const fiveThreeOne = result.stretches.find((s) => s.program === '5-3-1');
      expect(fiveThreeOne?.status).toBe('in-progress');
    });

    it('flags an unlabelled number overlapping a labelled one of the same program', () => {
      const rows = [
        ...run(RPT_DAYS, 0, 4, { spacing: 4, extra: () => ({ macrocycleNum: 1 }) }),
        ...run(RPT_DAYS, 2, 4, { spacing: 4, extra: () => ({ program: 'RPT', macrocycleNum: 2 }) }),
      ];
      expect(segment(rows).conflicts).toEqual([{ kind: 'numbers-overlap', stretches: [0, 1] }]);
    });

    it("keeps a blank Program cell with its own session's program when two programs share a number", () => {
      const rows = [
        ...run(FIVE_THREE_ONE_DAYS, 0, 6, { spacing: 4, extra: () => ({ program: '5/3/1', macrocycleNum: 1 }) }),
        ...run([['Rowing Machine']], 1, 6, { spacing: 4, extra: () => ({ program: 'Conditioning', macrocycleNum: 1 }) }),
        // The day after a Conditioning row: Deadlift's cell is blank, Overhead Press's isn't.
        { id: '24:Deadlift', date: day(24), lift: 'Deadlift', macrocycleNum: 1 },
        { id: '24:Overhead Press', date: day(24), lift: 'Overhead Press', program: '5/3/1', macrocycleNum: 1 },
      ];
      const result = segment(rows);
      const fiveThreeOne = result.stretches.find((s) => s.program === '5-3-1');
      expect(fiveThreeOne?.matched).toBe(true);
      expect(fiveThreeOne?.sessions.flatMap((s) => s.rows.map((r) => r.id))).toContain('24:Deadlift');
    });

    it('gives a blank Program cell the nearest label above it on its day', () => {
      // Each day: the 5/3/1 lifts, then a labelled Conditioning row, then a blank one.
      const rows = Array.from({ length: 6 }, (_, i): Row[] => [
        ...session(i * 4, FIVE_THREE_ONE_DAYS[i % 2] ?? [], { program: '5/3/1', macrocycleNum: 1 }),
        { id: `${i * 4}:row`, date: day(i * 4), lift: 'Rowing Machine', program: 'Conditioning', macrocycleNum: 1 },
        { id: `${i * 4}:row again`, date: day(i * 4), lift: 'Rowing Machine', macrocycleNum: 1 },
      ]).flat();
      const result = segment(rows, { importDate: day(26) });
      const fiveThreeOne = result.stretches.find((s) => s.program === '5-3-1');
      expect(fiveThreeOne).toMatchObject({ matched: true, status: 'in-progress' });
      expect(fiveThreeOne?.sessions.flatMap((s) => s.rows)).toHaveLength(12);
    });

    describe('a switch where the programs overlap by a few days', () => {
      // RPT #1 every 2 days over days 0–10, 5/3/1 #1 over 12 days from `switchDay`, then RPT #2.
      const switchAt = (switchDay: number) => [
        ...run(RPT_DAYS, 0, 6, { extra: () => ({ program: 'RPT', macrocycleNum: 1 }) }),
        ...run(FIVE_THREE_ONE_DAYS, switchDay, 6, { extra: () => ({ program: '5/3/1', macrocycleNum: 1 }) }),
        ...run(RPT_DAYS, switchDay + 12, 5, { extra: () => ({ program: 'RPT', macrocycleNum: 2 }) }),
      ];
      const statuses = (switchDay: number) => {
        const [rpt, fiveThreeOne] = segment(switchAt(switchDay)).stretches;
        return [rpt?.program, rpt?.reasons.status, fiveThreeOne?.program, fiveThreeOne?.reasons.status];
      };

      it.each([
        ['on the last day', 10],
        ['by a day', 9],
        ['by a week', 3],
      ])('reads an overlap %s as a hand-off on both sides', (_, switchDay) => {
        expect(statuses(switchDay)).toEqual([
          'rpt',
          { kind: 'next-is-different-program' },
          '5-3-1',
          { kind: 'next-is-different-program' },
        ]);
      });

      it('reads an overlap of more than a week as two programs running alongside', () => {
        // 5/3/1 starts 8 days before RPT #1 ends: RPT #2 follows RPT #1, and nothing follows 5/3/1.
        expect(statuses(2)).toEqual([
          'rpt',
          { kind: 'next-is-restart' },
          '5-3-1',
          { kind: 'inside-expected-length', weeksSinceStart: 3 },
        ]);
      });
    });

    it('counts sessions for a number with no Workout # when other numbers have them', () => {
      const first = run(FIVE_THREE_ONE_DAYS, 0, 24, { extra: () => ({ macrocycleNum: 1 }) });
      const rows = [
        ...first,
        ...run(FIVE_THREE_ONE_DAYS, lastDay(first) + 2, 3, { extra: (i) => ({ macrocycleNum: 2, workoutNum: i + 1 }) }),
      ];
      expect(segment(rows).stretches[0]).toMatchObject({ completedWorkouts: 24, status: 'completed' });
    });

    it('does not flag numbers that follow one another', () => {
      const first = run(RPT_DAYS, 0, 3, { extra: () => ({ macrocycleNum: 1 }) });
      const rows = [...first, ...run(RPT_DAYS, lastDay(first) + 2, 3, { extra: () => ({ macrocycleNum: 2 }) })];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(2);
      expect(result.stretches[0]?.status).toBe('abandoned');
      expect(result.conflicts).toEqual([]);
    });
  });
});
