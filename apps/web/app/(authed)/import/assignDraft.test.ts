import type { AssignStretch, ImportAssignResponse } from '@lifting-logbook/types';
import {
  buildBreakdown,
  canMoveStart,
  choicesFor,
  effectiveStretches,
  fileAllWithEarlier,
  fileSession,
  initialDraft,
  joinWithPrevious,
  moveStart,
  openDecisions,
  overlaps,
  setStatus,
  splitAtLargestGap,
} from './assignDraft';

const session = (date: string, lifts = ['Squat'], sets = 3) => ({ date, workoutNum: null, lifts, sets });

function stretch(dates: string[], over: Partial<AssignStretch> = {}): AssignStretch {
  return {
    program: 'rpt',
    matched: true,
    liftsOutsideProgram: [],
    candidateProgram: null,
    fileMacrocycleNum: null,
    fileGroup: null,
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
    ...over,
  };
}

const dates = (r: ImportAssignResponse, draft = initialDraft(r)) =>
  effectiveStretches(draft, r).map((s) => s.sessions.map((x) => x.date));

describe('assignDraft (#1256)', () => {
  it('starts from the suggestion, taking an export’s Status column as chosen', () => {
    const r = res({ stretches: [stretch(['2026-01-01'], { status: 'in-progress', fileStatus: 'abandoned' })], lone: [] });
    const draft = initialDraft(r);
    expect(draft.stretches[0]).toMatchObject({ status: 'abandoned', statusChosen: true });
    expect(draft.edited).toBe(false);
  });

  it('moves a start one session either way, never emptying a stretch', () => {
    const r = res({ lone: [] });
    let draft = initialDraft(r);
    draft = moveStart(draft, 's1', 'earlier');
    expect(dates(r, draft)).toEqual([['2026-01-01', '2026-01-03'], ['2026-01-05', '2026-02-01', '2026-02-03']]);
    draft = moveStart(moveStart(draft, 's1', 'later'), 's1', 'later');
    expect(dates(r, draft)).toEqual([['2026-01-01', '2026-01-03', '2026-01-05', '2026-02-01'], ['2026-02-03']]);
    expect(canMoveStart(draft, 's1', 'later')).toBe(false);
    expect(moveStart(draft, 's1', 'later')).toBe(draft);
    expect(canMoveStart(draft, 's0', 'earlier')).toBe(false);
    expect(draft.edited).toBe(true);
    // The rules read each status from sessions that have since moved; a chosen one stays.
    expect(draft.stretches.map((s) => s.status)).toEqual([null, null]);
    const chosen = moveStart(setStatus(initialDraft(r), 's1', 'overran'), 's1', 'earlier');
    expect(chosen.stretches.map((s) => s.status)).toEqual([null, 'overran']);
  });

  it('keeps sessions in date order, one per date, when a start moves between interleaved stretches', () => {
    const r = res({
      stretches: [stretch(['2026-01-01', '2026-01-10', '2026-01-20']), stretch(['2026-01-05', '2026-01-15', '2026-01-25'])],
      lone: [],
    });
    const moved = moveStart(initialDraft(r), 's1', 'later');
    expect(dates(r, moved)).toEqual([['2026-01-01', '2026-01-05', '2026-01-10', '2026-01-20'], ['2026-01-15', '2026-01-25']]);
    expect(overlaps(moved.stretches)).toHaveLength(1);

    const shared = res({ stretches: [stretch(['2026-01-01', '2026-01-05']), stretch(['2026-01-05', '2026-01-09'])], lone: [] });
    const merged = moveStart(initialDraft(shared), 's1', 'later');
    expect(merged.stretches[0]!.sessions).toEqual([session('2026-01-01'), session('2026-01-05', ['Squat'], 6)]);
  });

  it('joins a stretch into the one before, merging a shared date and leaving the status to choose', () => {
    const r = res({
      stretches: [stretch(['2026-01-01', '2026-01-05']), stretch(['2026-01-05', '2026-01-09'])],
      lone: [],
    });
    const joined = joinWithPrevious(initialDraft(r), 's1');
    expect(joined.stretches).toHaveLength(1);
    expect(joined.stretches[0]!.sessions.map((s) => s.date)).toEqual(['2026-01-01', '2026-01-05', '2026-01-09']);
    expect(joined.stretches[0]!.sessions[1]).toMatchObject({ sets: 6 });
    expect(joined.stretches[0]!.status).toBeNull();
    expect(openDecisions(joined, r)).toBe(1);

    const chosen = joinWithPrevious(setStatus(initialDraft(r), 's0', 'overran'), 's1');
    expect(chosen.stretches[0]).toMatchObject({ status: 'overran', statusChosen: true });
  });

  it('splits a stretch at its largest gap, leaving both halves’ status to choose', () => {
    const r = res({ stretches: [stretch(['2026-01-01', '2026-01-03', '2026-01-20', '2026-01-22'])], lone: [] });
    const split = splitAtLargestGap(initialDraft(r), 's0');
    expect(dates(r, split)).toEqual([['2026-01-01', '2026-01-03'], ['2026-01-20', '2026-01-22']]);
    expect(split.stretches.map((s) => s.status)).toEqual([null, null]);
    expect(new Set(split.stretches.map((s) => s.id)).size).toBe(2);
    expect(openDecisions(split, r)).toBe(2);

    const chosen = splitAtLargestGap(setStatus(initialDraft(r), 's0', 'abandoned'), 's0');
    expect(chosen.stretches.map((s) => s.status)).toEqual(['abandoned', 'abandoned']);

    const single = res({ stretches: [stretch(['2026-01-01'])], lone: [] });
    const draft = initialDraft(single);
    expect(splitAtLargestGap(draft, 's0')).toBe(draft);
  });

  it('never gives two stretches one id, however often a stretch is split', () => {
    const r = res({
      stretches: [stretch(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-20', '2026-01-21', '2026-01-22'])],
      lone: [],
    });
    // Split at Jan 3 → Jan 20, hand Jan 20 back, and split at that same gap again.
    let draft = splitAtLargestGap(initialDraft(r), 's0');
    draft = moveStart(draft, draft.stretches[1]!.id, 'later');
    draft = splitAtLargestGap(draft, 's0');
    expect(dates(r, draft)).toEqual([['2026-01-01', '2026-01-02', '2026-01-03'], ['2026-01-20'], ['2026-01-21', '2026-01-22']]);
    expect(new Set(draft.stretches.map((s) => s.id)).size).toBe(3);
  });

  it('asks again where a session goes once the stretch it was filed with changes', () => {
    const r = res();
    const filed = fileSession(initialDraft(r), '2026-01-20', 'later');
    // Joining takes away the stretch after it: it would otherwise be in no stretch at all.
    const joined = joinWithPrevious(filed, 's1');
    expect(joined.filed).toEqual({});
    expect(openDecisions(joined, r)).toBe(2);
    // An edit that leaves its neighbour alone keeps the choice.
    expect(setStatus(filed, 's1', 'abandoned').filed).toEqual({ '2026-01-20': 'later' });
    expect(fileSession(filed, '2026-01-20', 'non-cycle').filed).toEqual({ '2026-01-20': 'non-cycle' });
  });

  it('offers an export’s unnumbered session only places that need no stretch', () => {
    const p = { session: session('2026-01-20'), daysAfterPrevious: null, daysBeforeNext: null, unnumbered: true };
    expect(choicesFor(p, res({ exported: true }))).toEqual(['non-cycle', 'exclude']);
    expect(choicesFor(p, res())).toEqual(['earlier', 'later', 'non-cycle', 'exclude']);
    expect(choicesFor({ ...p, unnumbered: false }, res({ exported: true }))).toHaveLength(4);
  });

  it('files a lone session with either neighbour, or out of every stretch', () => {
    const r = res();
    expect(openDecisions(initialDraft(r), r)).toBe(1);
    const later = fileSession(initialDraft(r), '2026-01-20', 'later');
    expect(dates(r, later)[1]).toEqual(['2026-01-20', '2026-02-01', '2026-02-03']);
    expect(openDecisions(later, r)).toBe(0);

    const out = buildBreakdown(fileSession(initialDraft(r), '2026-01-20', 'exclude'), r);
    expect(out.excludedDates).toEqual(['2026-01-20']);
    expect(out.stretches.flatMap((s) => s.dates)).not.toContain('2026-01-20');
  });

  it('keeps every break by filing each undecided lone session with the stretch before it', () => {
    const r = res({
      lone: [
        { session: session('2025-12-20'), daysAfterPrevious: null, daysBeforeNext: 12 },
        { session: session('2026-01-20'), daysAfterPrevious: 15, daysBeforeNext: 12 },
      ],
    });
    const draft = fileAllWithEarlier(initialDraft(r), r);
    // The first has no stretch before it, so it's still the lifter's call.
    expect(draft.filed).toEqual({ '2026-01-20': 'earlier' });
    expect(dates(r, draft)[0]).toContain('2026-01-20');
  });

  it('counts overlapping stretches as decisions unless the file is an export, which sends its numbers', () => {
    // The group the server put the rows in, which no one Program cell need spell.
    const stretches = [
      stretch(['2026-01-01', '2026-01-10'], { fileMacrocycleNum: 1, fileGroup: 'name:my rpt' }),
      stretch(['2026-01-05', '2026-01-15'], { fileMacrocycleNum: 2, fileGroup: 'name:my rpt' }),
    ];
    const plain = res({ stretches, lone: [] });
    expect(overlaps(initialDraft(plain).stretches)).toHaveLength(1);
    expect(openDecisions(initialDraft(plain), plain)).toBe(1);

    const exported = res({ stretches, lone: [], exported: true });
    expect(openDecisions(initialDraft(exported), exported)).toBe(0);
    expect(buildBreakdown(initialDraft(exported), exported).stretches[0]).toEqual({
      program: 'rpt',
      status: 'completed',
      statusChosen: false,
      file: { program: 'name:my rpt', macrocycleNum: 1 },
    });
  });
});
