import { KnownProgram, liftKey } from '../../presets';
import { LiftHistoryRow, segmentLiftHistory, SegmentLiftHistoryOptions } from './segmentLiftHistory';

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

type Extra = Partial<Pick<Row, 'program' | 'macrocycleNum' | 'workoutNum'>>;

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

const lastDay = (rows: readonly Row[]): number =>
  Math.max(
    ...rows.flatMap((r) =>
      r.date && !Number.isNaN(r.date.getTime())
        ? [Math.round((r.date.getTime() - day(0).getTime()) / 86_400_000)]
        : [],
    ),
  );

function segment(rows: Row[], options: Partial<SegmentLiftHistoryOptions> = {}) {
  return segmentLiftHistory(rows, {
    importDate: day(lastDay(rows) + 2),
    sourceProgram: 'rpt',
    ...options,
  });
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
  });

  describe('program precedence (decision 9)', () => {
    it("takes the file's column over the lifts", () => {
      const result = segment(run(RPT_DAYS, 0, 3, { extra: () => ({ program: '5/3/1' }) }));
      expect(result.stretches[0]?.program).toBe('5-3-1');
      expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'column', value: '5/3/1' });
    });

    it('takes the lifts over the Source program', () => {
      const result = segment(run(RPT_DAYS, 0, 3), { sourceProgram: '5-3-1' });
      expect(result.stretches[0]?.program).toBe('rpt');
      expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'lifts', tiedWith: [] });
    });

    describe('a tie', () => {
      const custom = (id: string, lifts: string[]): KnownProgram => ({
        id,
        name: id,
        lifts: new Set(lifts.map(liftKey)),
        workoutCount: 12,
        lengthWeeks: 4,
      });
      const customPrograms = [
        custom('zeta', ['Squat', 'Bench Press', 'Barbell Row']),
        custom('alpha', ['Squat', 'Bench Press', 'Face Pull']),
      ];
      const rows = run([['Squat', 'Bench Press']], 0, 3);

      it('goes to the Source program', () => {
        const result = segment(rows, { customPrograms, sourceProgram: 'zeta' });
        expect(result.stretches[0]?.program).toBe('zeta');
        expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'lifts', tiedWith: ['alpha'] });
      });

      it('goes to the first program by name when the Source program is not tied, naming the rest', () => {
        const result = segment(rows, { customPrograms, sourceProgram: 'rpt' });
        expect(result.stretches[0]?.program).toBe('alpha');
        expect(result.stretches[0]?.reasons.program).toEqual({ kind: 'lifts', tiedWith: ['zeta'] });
      });
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
  });

  describe("a file's macrocycle numbers (decision 8)", () => {
    it('keeps its groupings and flags a break inside one number, without lone flags', () => {
      const first = run(RPT_DAYS, 0, 3, { extra: () => ({ macrocycleNum: 1 }) });
      const rows = [
        ...first,
        ...session(lastDay(first) + 10, ['Squat'], { macrocycleNum: 1 }),
        ...run(RPT_DAYS, lastDay(first) + 30, 3, { extra: () => ({ macrocycleNum: 1 }) }),
      ];
      const result = segment(rows);
      expect(result.stretches).toHaveLength(1);
      expect(result.stretches[0]).toMatchObject({ fileMacrocycleNum: 1, reasons: { start: { kind: 'file-macrocycle', macrocycleNum: 1 } } });
      expect(result.lone).toEqual([]);
      expect(result.conflicts).toEqual([
        { kind: 'gap-inside-number', stretch: 0, from: day(lastDay(first) + 10), to: day(lastDay(first) + 30), days: 20 },
      ]);
    });

    it('flags two numbers in one program whose dates interleave', () => {
      const rows = [
        ...run(RPT_DAYS, 0, 4, { spacing: 4, extra: () => ({ macrocycleNum: 1 }) }),
        ...run(RPT_DAYS, 2, 4, { spacing: 4, extra: () => ({ macrocycleNum: 2 }) }),
      ];
      const result = segment(rows);
      expect(result.stretches.map((s) => s.fileMacrocycleNum)).toEqual([1, 2]);
      expect(result.conflicts).toEqual([{ kind: 'numbers-overlap', stretches: [0, 1] }]);
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
