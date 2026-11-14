import { segmentLiftHistory, toLiftHistoryRecord, type LiftRecord } from '@lifting-logbook/core';
import {
  IMPORT_DATE,
  PROGRAMS,
  fiveThreeOne,
  rowsOf,
  segment,
  twoRuns,
  ymdOf,
} from '../testing/import-suggestion-fixtures';
import { buildSuggestionPayload, type SuggestionProgram } from './suggestion-payload';
import { MAX_SUGGESTIONS, MAX_SUGGESTION_TEXT, validateSuggestions } from './suggestion-validation';

const CUSTOM: SuggestionProgram = { id: 'prog-abc123', name: 'My Secret Plan', workouts: 12, weeks: 6 };

function setup(rows: LiftRecord[] = twoRuns(), exported = false, segmented = segment(rows)) {
  const built = buildSuggestionPayload(
    { segmented, importDate: IMPORT_DATE, programs: [...PROGRAMS, CUSTOM], exported, notes: false },
    new Map([['zercher-hold', 'Zercher Hold']]),
  );
  return (...suggestions: unknown[]) => validateSuggestions({ suggestions }, segmented, built, exported);
}

const NONE = { malformed: 0, 'unknown-lift': 0, 'out-of-range': 0 };

// twoRuns(): stretches start on day 0 and day 44; sessions every other day to day 14 and day 54.
describe('validateSuggestions (#1174)', () => {
  describe('the response as a whole', () => {
    it.each([
      ['a string', 'add a boundary'],
      ['null', null],
      ['an array', []],
      ['an object with no suggestions', { ideas: [] }],
      ['suggestions that are not an array', { suggestions: 'none' }],
    ])('counts %s as one malformed answer', (_label, output) => {
      const segmented = segment(twoRuns());
      const built = buildSuggestionPayload(
        { segmented, importDate: IMPORT_DATE, programs: PROGRAMS, exported: false, notes: false },
        new Map(),
      );
      expect(validateSuggestions(output, segmented, built, false)).toEqual({
        suggestions: [],
        dropped: { ...NONE, malformed: 1 },
      });
    });

    it('keeps an empty list as no suggestions and nothing dropped', () => {
      expect(setup()()).toEqual({ suggestions: [], dropped: NONE });
    });

    it(`keeps at most ${MAX_SUGGESTIONS} and counts the rest as out of range`, () => {
      const notes = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, i) => ({ kind: 'note', text: `note ${i}` }));
      const result = setup()(...notes);
      expect(result.suggestions).toHaveLength(MAX_SUGGESTIONS);
      expect(result.dropped).toEqual({ ...NONE, 'out-of-range': 5 });
    });
  });

  describe('each suggestion', () => {
    it.each([
      ['not an object', 'boundary'],
      ['no kind', { reason: 'x' }],
      ['an unknown kind', { kind: 'rename', reason: 'x' }],
      ['an empty reason', { kind: 'boundary', action: 'add', date: ymdOf(4), reason: '  ' }],
      ['no reason', { kind: 'boundary', action: 'add', date: ymdOf(4) }],
      ['a reason over the limit', { kind: 'boundary', action: 'add', date: ymdOf(4), reason: 'x'.repeat(MAX_SUGGESTION_TEXT + 1) }],
      ['lifts that are not strings', { kind: 'note', text: 'x', lifts: [1] }],
      ['an unknown action', { kind: 'boundary', action: 'move', date: ymdOf(4), reason: 'x' }],
      ['a date that is not a day', { kind: 'boundary', action: 'add', date: '2026-02-30', reason: 'x' }],
      ['a date in another format', { kind: 'boundary', action: 'add', date: '01/09/2026', reason: 'x' }],
      ['a note with a bad date', { kind: 'note', from: 'last week', to: null, text: 'x' }],
    ])('drops one with %s as malformed', (_label, item) => {
      expect(setup()(item)).toEqual({ suggestions: [], dropped: { ...NONE, malformed: 1 } });
    });

    it('drops one naming a lift that was not sent, and keeps one naming sent lifts in any case', () => {
      const result = setup()(
        { kind: 'note', text: 'squat stalled', lifts: ['Back Squat', 'front squat'] },
        { kind: 'note', text: 'squat stalled', lifts: ['back squat', 'BENCH PRESS'] },
      );
      expect(result.suggestions).toEqual([{ kind: 'note', from: null, to: null, text: 'squat stalled' }]);
      expect(result.dropped).toEqual({ ...NONE, 'unknown-lift': 1 });
    });
  });

  describe('boundaries', () => {
    it('keeps a new boundary on a session inside a stretch, and removing one that is not the first', () => {
      const result = setup()(
        { kind: 'boundary', action: 'add', date: ymdOf(8), reason: 'weights reset' },
        { kind: 'boundary', action: 'remove', date: ymdOf(44), reason: 'same run' },
      );
      expect(result).toEqual({
        suggestions: [
          { kind: 'boundary', action: 'add', date: ymdOf(8), reason: 'weights reset' },
          { kind: 'boundary', action: 'remove', date: ymdOf(44), reason: 'same run' },
        ],
        dropped: NONE,
      });
    });

    it.each([
      ['adding one where a stretch already starts', { action: 'add', date: ymdOf(44) }],
      ['adding one on a day with no session', { action: 'add', date: ymdOf(5) }],
      ['adding one outside the file', { action: 'add', date: '2025-06-01' }],
      ['removing the first stretch’s start', { action: 'remove', date: ymdOf(0) }],
      ['removing one where no stretch starts', { action: 'remove', date: ymdOf(8) }],
    ])('drops %s as out of range', (_label, fields) => {
      expect(setup()({ kind: 'boundary', reason: 'x', ...fields }).dropped).toEqual({ ...NONE, 'out-of-range': 1 });
    });

    it('drops any boundary for this app’s export, whose macrocycles are its own', () => {
      expect(setup(twoRuns(), true)({ kind: 'boundary', action: 'add', date: ymdOf(8), reason: 'x' }).dropped).toEqual({
        ...NONE,
        'out-of-range': 1,
      });
    });
  });

  describe('lone and unnumbered sessions', () => {
    const withLone = () => rowsOf([...fiveThreeOne(0, 8), { day: 30, lifts: ['back-squat'] }, ...fiveThreeOne(60, 6)]);

    it('keeps a choice for a lone session', () => {
      expect(setup(withLone())({ kind: 'lone', date: ymdOf(30), choice: 'non-cycle', reason: 'a test day' })).toEqual({
        suggestions: [{ kind: 'lone', date: ymdOf(30), choice: 'non-cycle', reason: 'a test day' }],
        dropped: NONE,
      });
    });

    it.each([
      ['an unknown choice', { date: ymdOf(30), choice: 'sideways' }],
      ['a session that is not lone', { date: ymdOf(4), choice: 'exclude' }],
    ])('drops %s as out of range', (_label, fields) => {
      expect(setup(withLone())({ kind: 'lone', reason: 'x', ...fields }).dropped).toEqual({ ...NONE, 'out-of-range': 1 });
    });

    it('drops filing an export’s unnumbered session with a stretch, and keeps excluding it', () => {
      // By file numbers, as an export is read: a session with no number and no numbered row above
      // it to take one from is listed unnumbered.
      const rows = [
        ...rowsOf([{ day: 10, lifts: ['back-squat'] }]),
        ...rowsOf(fiveThreeOne(0, 4)).map((row, i) => ({ ...row, program: '5-3-1', macrocycleNum: 1, workoutNum: Math.floor(i / 6) + 1 })),
      ];
      const segmented = segmentLiftHistory(rows.map(toLiftHistoryRecord), {
        importDate: IMPORT_DATE,
        sourceProgram: '5-3-1',
        customPrograms: [],
        placeByDate: false,
      });
      expect(segmented.unnumbered.length).toBeGreaterThan(0);
      const validate = setup(rows, true, segmented);

      expect(validate({ kind: 'lone', date: ymdOf(10), choice: 'earlier', reason: 'x' }).dropped).toEqual({ ...NONE, 'out-of-range': 1 });
      expect(validate({ kind: 'lone', date: ymdOf(10), choice: 'exclude', reason: 'x' }).suggestions).toHaveLength(1);
    });
  });

  describe('status and program', () => {
    it('keeps a status that differs from the rules’, for a stretch named by its start', () => {
      expect(setup()({ kind: 'status', stretchStart: ymdOf(44), status: 'in-progress', reason: 'still running' })).toEqual({
        suggestions: [{ kind: 'status', stretchStart: ymdOf(44), status: 'in-progress', reason: 'still running' }],
        dropped: NONE,
      });
    });

    it.each([
      ['the status it already has', { stretchStart: ymdOf(44), status: 'abandoned' }],
      ['an unknown status', { stretchStart: ymdOf(44), status: 'paused' }],
      ['a date where no stretch starts', { stretchStart: ymdOf(46), status: 'completed' }],
    ])('drops a status naming %s as out of range', (_label, fields) => {
      expect(setup()({ kind: 'status', reason: 'x', ...fields }).dropped).toEqual({ ...NONE, 'out-of-range': 1 });
    });

    it('keeps a program change, mapping a placeholder back to the program’s id', () => {
      const result = setup()(
        { kind: 'program', stretchStart: ymdOf(0), program: 'rpt', reason: 'x' },
        { kind: 'program', stretchStart: ymdOf(44), program: 'custom-program-1', reason: 'like custom-program-1' },
      );
      expect(result).toEqual({
        suggestions: [
          { kind: 'program', stretchStart: ymdOf(0), program: 'rpt', reason: 'x' },
          { kind: 'program', stretchStart: ymdOf(44), program: 'prog-abc123', reason: 'like My Secret Plan' },
        ],
        dropped: NONE,
      });
    });

    it.each([
      ['the program it already has', '5-3-1'],
      ['a program that was not sent', 'starting-strength'],
      ['a custom program by its real id', 'prog-abc123'],
    ])('drops a program change naming %s as out of range', (_label, program) => {
      expect(setup()({ kind: 'program', stretchStart: ymdOf(0), program, reason: 'x' }).dropped).toEqual({
        ...NONE,
        'out-of-range': 1,
      });
    });
  });

  describe('notes', () => {
    it('keeps a note inside the file’s dates and restores placeholders in its text', () => {
      const rows = rowsOf([...fiveThreeOne(0, 4), { day: 8, lifts: ['zercher-hold', 'back-squat'] }]);
      expect(setup(rows)({ kind: 'note', from: ymdOf(0), to: ymdOf(8), text: 'custom-lift-1 every week' })).toEqual({
        suggestions: [{ kind: 'note', from: ymdOf(0), to: ymdOf(8), text: 'Zercher Hold every week' }],
        dropped: NONE,
      });
    });

    it('restores each whole placeholder once, with ten or more custom lifts', () => {
      // Eleven custom lifts, numbered custom-lift-1 to custom-lift-11 in order of first appearance.
      const ids = Array.from({ length: 11 }, (_, i) => `own-${i + 1}`);
      const names = new Map(ids.map((id, i) => [id, `Own Lift ${i + 1}`]));
      // A lifter's name that reads like a placeholder isn't replaced a second time.
      names.set('own-1', 'custom-lift-2 copy');
      const segmented = segment(rowsOf([...fiveThreeOne(0, 4), { day: 8, lifts: ids }]));
      const built = buildSuggestionPayload(
        { segmented, importDate: IMPORT_DATE, programs: PROGRAMS, exported: false, notes: false },
        names,
      );
      expect(built.placeholders.get('custom-lift-10')).toBe('Own Lift 10');
      const text = 'custom-lift-10 then custom-lift-1, custom-lift-11; custom-lift-99 is unknown';
      expect(validateSuggestions({ suggestions: [{ kind: 'note', from: null, to: null, text }] }, segmented, built, false)).toEqual({
        suggestions: [
          { kind: 'note', from: null, to: null, text: 'Own Lift 10 then custom-lift-2 copy, Own Lift 11; custom-lift-99 is unknown' },
        ],
        dropped: NONE,
      });
    });

    it('drops a note dated outside the file as out of range', () => {
      expect(setup()({ kind: 'note', from: ymdOf(0), to: '2026-10-01', text: 'x' }).dropped).toEqual({
        ...NONE,
        'out-of-range': 1,
      });
    });
  });
});
