import { IMPORT_SUGGESTION_MAX_SETS } from '@lifting-logbook/types';
import type { LiftRecord } from '@lifting-logbook/core';
import {
  ALLOWED_PAYLOAD_PATHS,
  IMPORT_DATE,
  PROGRAMS,
  fiveThreeOne,
  payloadPaths,
  rowsOf,
  segment,
  twoRuns,
  ymdOf,
} from '../testing/import-suggestion-fixtures';
import { buildSuggestionPayload, type SuggestionProgram } from './suggestion-payload';

function build(
  rows: LiftRecord[],
  opts: { notes?: boolean; programs?: SuggestionProgram[]; liftNames?: Map<string, string>; exported?: boolean } = {},
) {
  return buildSuggestionPayload(
    {
      segmented: segment(rows),
      importDate: IMPORT_DATE,
      programs: opts.programs ?? PROGRAMS,
      exported: opts.exported ?? false,
      notes: opts.notes ?? false,
    },
    opts.liftNames ?? new Map(),
  );
}

/** The file's own text that must never be sent: a Program cell, a file number, a note. */
function withFileText(rows: LiftRecord[]): LiftRecord[] {
  return rows.map((row) => ({ ...row, program: 'Sheet Program Cell', macrocycleNum: 7, notes: 'felt heavy today' }));
}

describe('buildSuggestionPayload (#1174)', () => {
  describe('what is sent', () => {
    it('carries only the allowed fields, and no notes unless the lifter opts in', () => {
      const built = build(withFileText(twoRuns()));
      const paths = payloadPaths(built.payload);

      expect([...paths].filter((p) => !ALLOWED_PAYLOAD_PATHS.has(p))).toEqual([]);
      expect(paths.has('sessions[].sets[].notes')).toBe(false);
      const json = JSON.stringify(built.payload);
      expect(json).not.toContain('felt heavy today');
      expect(json).not.toContain('Sheet Program Cell');
      // Each set's date, lift name, set number, weight and reps.
      expect(built.payload.sessions[0]).toEqual({
        date: ymdOf(0),
        sets: [
          { lift: 'Back Squat', set: 1, weight: 200, reps: 5 },
          { lift: 'Back Squat', set: 2, weight: 210, reps: 5 },
          { lift: 'Back Squat', set: 3, weight: 220, reps: 5 },
          { lift: 'Bench Press', set: 1, weight: 200, reps: 5 },
          { lift: 'Bench Press', set: 2, weight: 210, reps: 5 },
          { lift: 'Bench Press', set: 3, weight: 220, reps: 5 },
        ],
      });
      expect(built).toMatchObject({ sets: 84, fits: true, summarizedSessions: 0 });
    });

    it('adds each set’s notes when the lifter opts in, and only then', () => {
      const built = build(withFileText(twoRuns()), { notes: true });
      const paths = payloadPaths(built.payload);

      expect([...paths].filter((p) => !ALLOWED_PAYLOAD_PATHS.has(p))).toEqual([]);
      expect(paths.has('sessions[].sets[].notes')).toBe(true);
      expect(JSON.stringify(built.payload)).not.toContain('Sheet Program Cell');
      expect(built.payload.sessions[0]).toMatchObject({ sets: expect.arrayContaining([expect.objectContaining({ notes: 'felt heavy today' })]) });
    });

    it('leaves a blank note out even when notes are on', () => {
      const built = build(twoRuns({ notes: '   ' }), { notes: true });
      expect(payloadPaths(built.payload).has('sessions[].sets[].notes')).toBe(false);
    });

    it('sends the rules’ stretches with their start reason’s kind and nothing else from the reasons', () => {
      const { payload } = build(twoRuns());
      expect(payload.stretches).toEqual([
        {
          start: ymdOf(0),
          end: ymdOf(14),
          program: '5-3-1',
          matched: true,
          status: 'abandoned',
          startReason: 'first-session',
          sessions: 8,
          completedWorkouts: 8,
          expectedWorkouts: 24,
        },
        expect.objectContaining({ start: ymdOf(44), end: ymdOf(54), startReason: 'gap', sessions: 6 }),
      ]);
      expect(payload).toMatchObject({ importDate: '2026-11-14', exportedFile: false });
    });

    it('sends a lone session as a flag with its gaps', () => {
      const { payload } = build(rowsOf([...fiveThreeOne(0, 8), { day: 30, lifts: ['back-squat'] }, ...fiveThreeOne(60, 6)]));
      expect(payload.flags.lone).toEqual([{ date: ymdOf(30), daysAfterPrevious: 16, daysBeforeNext: 30 }]);
      expect(payload.sessions.map((s) => s.date)).toContain(ymdOf(30));
    });
  });

  describe('placeholders', () => {
    it('sends a custom lift as a placeholder and maps it back to the lifter’s name', () => {
      const rows = rowsOf([...fiveThreeOne(0, 4), { day: 8, lifts: ['zercher-hold', 'back-squat'] }]);
      const built = build(rows, { liftNames: new Map([['zercher-hold', 'Zercher Hold']]) });
      const json = JSON.stringify(built.payload);

      expect(json).not.toMatch(/zercher/i);
      expect(json).toContain('custom-lift-1');
      expect(built.lifts.get('custom-lift-1')).toBe('Zercher Hold');
      expect(built.lifts.get('back squat')).toBe('back-squat');
      expect(built.placeholders).toEqual(new Map([['custom-lift-1', 'Zercher Hold']]));
    });

    it('sends a custom program as a placeholder and maps it back to its id and name', () => {
      const programs = [...PROGRAMS, { id: 'prog-abc123', name: 'My Secret Plan', workouts: 12, weeks: 6 }];
      const built = build(twoRuns(), { programs });
      const json = JSON.stringify(built.payload);

      expect(json).not.toContain('My Secret Plan');
      expect(json).not.toContain('prog-abc123');
      expect(built.payload.programs).toContainEqual({ id: 'custom-program-1', name: 'custom-program-1', workouts: 12, weeks: 6 });
      expect(built.programs.get('custom-program-1')).toBe('prog-abc123');
      expect(built.programs.get('rpt')).toBe('rpt');
      expect(built.placeholders.get('custom-program-1')).toBe('My Secret Plan');
    });
  });

  describe('over the 1,500-set cap', () => {
    // 40 sessions of 40 sets: 1,600, with a 32-day break between two runs of 20.
    const bigTwoRuns = () =>
      rowsOf([...fiveThreeOne(0, 20, { setsPerLift: 20 }), ...fiveThreeOne(70, 20, { setsPerLift: 20 })]);

    it('keeps every set only for the two sessions each side of a break, and top sets elsewhere', () => {
      const rows = bigTwoRuns();
      expect(rows.length).toBeGreaterThan(IMPORT_SUGGESTION_MAX_SETS);
      const built = build(rows);
      const full = built.payload.sessions.filter((s) => 'sets' in s).map((s) => s.date);

      expect(full).toEqual([ymdOf(36), ymdOf(38), ymdOf(70), ymdOf(72)]);
      expect(built.summarizedSessions).toBe(36);
      // Summaries' top sets count toward the cap: 4 sessions of 40 sets, 36 of 2 top sets.
      expect(built).toMatchObject({ sets: 4 * 40 + 36 * 2, fits: true });
      expect(built.payload.sessions[0]).toEqual({
        date: ymdOf(0),
        topSets: [
          { lift: 'Back Squat', weight: 390, reps: 5 },
          { lift: 'Bench Press', weight: 390, reps: 5 },
        ],
      });
      expect([...payloadPaths(built.payload)].filter((p) => !ALLOWED_PAYLOAD_PATHS.has(p))).toEqual([]);
    });

    it('keeps every set for two sessions each side of a lone session', () => {
      const rows = rowsOf([
        ...fiveThreeOne(0, 20, { setsPerLift: 20 }),
        { day: 60, lifts: ['back-squat'], setsPerLift: 3 },
        ...fiveThreeOne(90, 20, { setsPerLift: 20 }),
      ]);
      const built = build(rows);
      expect(built.payload.flags.lone.map((l) => l.date)).toEqual([ymdOf(60)]);
      const full = built.payload.sessions.filter((s) => 'sets' in s).map((s) => s.date);

      expect(full).toEqual([ymdOf(36), ymdOf(38), ymdOf(60), ymdOf(90), ymdOf(92)]);
    });

    it('keeps every set of an unmatched stretch', () => {
      const rows = rowsOf([
        ...fiveThreeOne(0, 30, { setsPerLift: 30 }),
        ...[100, 102, 104].map((day) => ({ day, lifts: ['front-squat', 'barbell-row'] })),
      ]);
      const segmented = segment(rows);
      const unmatched = segmented.stretches.filter((s) => !s.matched);
      expect(unmatched.length).toBeGreaterThan(0);
      const unmatchedDates = new Set(unmatched.flatMap((s) => s.sessions.map((x) => x.date.toISOString().slice(0, 10))));
      const built = build(rows);

      expect(built.summarizedSessions).toBeGreaterThan(0);
      for (const session of built.payload.sessions) {
        if (unmatchedDates.has(session.date)) expect('sets' in session).toBe(true);
      }
    });

    it('reports a file still over the cap after reducing it as not fitting', () => {
      // 30 unmatched sessions of 60 sets: every set must go, 1,800 of them.
      const rows = rowsOf(
        Array.from({ length: 30 }, (_, i) => ({ day: i * 2, lifts: ['front-squat', 'barbell-row'], setsPerLift: 30 })),
      );
      const built = build(rows);
      expect(built.sets).toBe(1_800);
      expect(built.fits).toBe(false);
    });

    it('does not reduce a file at the cap', () => {
      // 25 sessions of 60 sets: exactly 1,500.
      const rows = rowsOf(fiveThreeOne(0, 25, { setsPerLift: 30 }));
      const built = build(rows);
      expect(built).toMatchObject({ sets: 1_500, fits: true, summarizedSessions: 0 });
    });
  });
});
