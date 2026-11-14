import type { AssignStretch, ImportAssignResponse, ImportSuggestion } from '@lifting-logbook/types';
import { effectiveStretches, initialDraft, moveStart, setProgram, setStatus, fileSession, type AssignDraft } from './assignDraft';
import { acceptSuggestion, suggestionApplies } from './suggestionDraft';

const session = (date: string, lifts = ['Squat']) => ({ date, workoutNum: null, lifts, sets: 3 });

function stretch(dates: string[], over: Partial<AssignStretch> = {}): AssignStretch {
  return {
    program: 'rpt',
    matched: true,
    liftsOutsideProgram: [],
    candidateProgram: null,
    fileMacrocycleNum: null,
    fileGroup: null,
    stored: { kind: 'new' },
    startDate: dates[0]!,
    endDate: dates[dates.length - 1]!,
    sessions: dates.map((d) => session(d)),
    completedWorkouts: dates.length,
    expectedWorkouts: 24,
    status: 'completed',
    fileStatus: null,
    reasons: {
      start: { kind: 'first-session' },
      program: { kind: 'lifts', tiedWith: [], bySetOrder: false },
      status: { kind: 'all-workouts-done' },
    },
    ...over,
  };
}

function res(over: Partial<ImportAssignResponse> = {}): ImportAssignResponse {
  return {
    importDate: '2026-11-13',
    sessions: 6,
    stretches: [stretch(['2026-01-01', '2026-01-03', '2026-01-05']), stretch(['2026-02-01', '2026-02-03'])],
    lone: [{ session: session('2026-01-20', ['Bench Press']), daysAfterPrevious: 15, daysBeforeNext: 12 }],
    nonCycle: [],
    unnumbered: [],
    conflicts: [],
    undatedRows: 0,
    exported: false,
    programs: [],
    suggestions: { provider: 'Test model' },
    ...over,
  };
}

const dates = (r: ImportAssignResponse, draft: AssignDraft) =>
  effectiveStretches(draft, r).map((s) => s.sessions.map((x) => x.date));

const ADD: ImportSuggestion = { kind: 'boundary', action: 'add', date: '2026-01-03', reason: 'weights reset' };
const REMOVE: ImportSuggestion = { kind: 'boundary', action: 'remove', date: '2026-02-01', reason: 'one run' };
const LONE: ImportSuggestion = { kind: 'lone', date: '2026-01-20', choice: 'non-cycle', reason: 'a test day' };
const STATUS: ImportSuggestion = { kind: 'status', stretchStart: '2026-02-01', status: 'abandoned', reason: 'stopped' };
const PROGRAM: ImportSuggestion = { kind: 'program', stretchStart: '2026-02-01', program: '5-3-1', reason: 'its lifts' };
const NOTE: ImportSuggestion = { kind: 'note', from: null, to: null, text: 'squat stalled' };

describe('suggestionDraft (#1174)', () => {
  it('starts a new macrocycle where a boundary is suggested', () => {
    const r = res();
    const draft = initialDraft(r);
    expect(suggestionApplies(ADD, draft, r)).toBe(true);
    const next = acceptSuggestion(ADD, draft, r);
    expect(dates(r, next)).toEqual([['2026-01-01'], ['2026-01-03', '2026-01-05'], ['2026-02-01', '2026-02-03']]);
    // Done once, it no longer applies.
    expect(suggestionApplies(ADD, next, r)).toBe(false);
  });

  it('joins a macrocycle with the one before it where a boundary removal is suggested', () => {
    const r = res();
    const draft = initialDraft(r);
    expect(suggestionApplies(REMOVE, draft, r)).toBe(true);
    expect(dates(r, acceptSuggestion(REMOVE, draft, r))).toEqual([
      ['2026-01-01', '2026-01-03', '2026-01-05', '2026-02-01', '2026-02-03'],
    ]);
    expect(suggestionApplies({ ...REMOVE, date: '2026-01-01' }, draft, r)).toBe(false);
  });

  it('drops a boundary suggestion about a stretch the lifter has reshaped', () => {
    const r = res();
    // Moving the second stretch's start reshapes both.
    const moved = moveStart(initialDraft(r), 's1', 'earlier');
    expect(suggestionApplies(ADD, moved, r)).toBe(false);
    expect(suggestionApplies(REMOVE, moved, r)).toBe(false);
    expect(acceptSuggestion(ADD, moved, r)).toBe(moved);
  });

  it('applies no boundary suggestion to an export', () => {
    const r = res({ exported: true });
    expect(suggestionApplies(ADD, initialDraft(r), r)).toBe(false);
    expect(suggestionApplies(REMOVE, initialDraft(r), r)).toBe(false);
  });

  it('files a lone session, unless the lifter already has', () => {
    const r = res();
    const draft = initialDraft(r);
    expect(suggestionApplies(LONE, draft, r)).toBe(true);
    expect(acceptSuggestion(LONE, draft, r).filed).toEqual({ '2026-01-20': 'non-cycle' });

    const filed = fileSession(draft, '2026-01-20', 'exclude');
    expect(suggestionApplies(LONE, filed, r)).toBe(false);
    expect(suggestionApplies({ ...LONE, date: '2026-01-03' }, draft, r)).toBe(false);
  });

  it('sets a status the rules didn’t, unless the lifter chose one', () => {
    const r = res();
    const draft = initialDraft(r);
    expect(suggestionApplies(STATUS, draft, r)).toBe(true);
    expect(acceptSuggestion(STATUS, draft, r).stretches[1]).toMatchObject({ status: 'abandoned', statusChosen: true });

    expect(suggestionApplies(STATUS, setStatus(draft, 's1', 'in-progress'), r)).toBe(false);
    expect(suggestionApplies({ ...STATUS, status: 'completed' }, draft, r)).toBe(false);
  });

  it('sets a program, unless the lifter changed it', () => {
    const r = res();
    const draft = initialDraft(r);
    expect(suggestionApplies(PROGRAM, draft, r)).toBe(true);
    expect(acceptSuggestion(PROGRAM, draft, r).stretches[1]?.program).toBe('5-3-1');

    expect(suggestionApplies(PROGRAM, setProgram(draft, 's1', 'leangains'), r)).toBe(false);
  });

  it('changes nothing for a note, which always applies', () => {
    const r = res();
    const draft = initialDraft(r);
    expect(suggestionApplies(NOTE, draft, r)).toBe(true);
    expect(acceptSuggestion(NOTE, draft, r)).toBe(draft);
  });
});
