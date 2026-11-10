import { BUILT_IN_KNOWN_PROGRAMS } from '../../presets';
import {
  KnownProgram,
  liftKey,
  matchProgramForLifts,
  programNamedBy,
  programsContaining,
} from '../../presets/programMatching';
import { toUTCMidnight } from '../jsUtil';

/**
 * The rules version of the import wizard's Assign step (#1172): groups imported lift
 * history into stretches, each a suggested macrocycle, from its dates. It follows
 * decisions 4 to 9 of `docs/proposals/2026-11-06-import-macrocycle-assignment.md`, and
 * every suggestion is for the lifter to review and change.
 *
 * A session is every row with one date.
 */

/** A break of more than this many days between sessions suggests a new macrocycle (decision 4). */
export const BREAK_DAYS = 14;

const DAY_MS = 86_400_000;

/** The fields segmentation reads. `LiftRecord` satisfies it. */
export interface LiftHistoryRow {
  /** Missing or invalid: the row is returned in `unplaced`. */
  date?: Date | null;
  lift: string;
  /** The file's `Program` cell, when the column is mapped. */
  program?: string | null;
  /** The file's `Macrocycle #` cell, when the column is mapped. */
  macrocycleNum?: number | null;
  /** The file's `Workout #` cell, when the column is mapped. */
  workoutNum?: number | null;
}

export interface SegmentLiftHistoryOptions {
  /** The day of the import; a last stretch's status is judged against it. */
  importDate: Date;
  /** The program picked at the Source step. */
  sourceProgram: string;
  /** The lifter's custom programs, matched after the built-ins, in name order. */
  customPrograms?: readonly KnownProgram[];
}

export type StretchStatus = 'in-progress' | 'completed' | 'overran' | 'abandoned';

export interface HistorySession<T> {
  /** UTC midnight of the session's day. */
  date: Date;
  rows: T[];
  /** The file's lowest workout number on this day when the file numbers workouts, else its place in the stretch from 1. */
  workoutNum: number;
}

/** Why a stretch starts where it does. */
export type StretchStartReason =
  | { kind: 'first-session' }
  | { kind: 'gap'; days: number }
  | { kind: 'previous-run-finished' }
  | { kind: 'program-column-changed'; from: string; to: string }
  | { kind: 'lift-outside-program'; lifts: string[] }
  | { kind: 'workout-number-fell-back'; from: number; to: number }
  | { kind: 'file-macrocycle'; macrocycleNum: number };

/** Where a stretch's program came from (decision 9). */
export type StretchProgramReason =
  | { kind: 'column'; value: string }
  | { kind: 'lifts'; tiedWith: string[] }
  | { kind: 'source' };

/** Why a stretch has its status, or none. */
export type StretchStatusReason =
  | { kind: 'all-workouts-done' }
  | { kind: 'next-is-restart' }
  | { kind: 'next-is-different-program' }
  | { kind: 'last-session-stale'; daysBeforeImport: number }
  | { kind: 'past-expected-length'; weeksSinceStart: number }
  | { kind: 'inside-expected-length'; weeksSinceStart: number }
  | { kind: 'unmatched' };

export interface HistoryStretch<T> {
  /** The suggested program: a known one, or the Source program when unmatched. */
  program: string;
  /**
   * Whether every lift belongs to `program`, so its length is known. An unmatched stretch
   * has no suggested status, and the lifter confirms its program and status at Assign.
   */
  matched: boolean;
  /**
   * The lifts that keep the stretch from matching, as first spelled in the file: those
   * outside `candidateProgram` when there is one, else outside `program`. Empty when matched.
   */
  liftsOutsideProgram: string[];
  /**
   * For an unmatched stretch, the known program its other lifts match, if any: the one it
   * would be if the lifter confirms the lifts outside it progress the same way.
   */
  candidateProgram?: string;
  /** The file's macrocycle number, when the file has them (decision 8). */
  fileMacrocycleNum?: number;
  startDate: Date;
  endDate: Date;
  sessions: HistorySession<T>[];
  /** Distinct file workout numbers when the file numbers workouts, else sessions (decision 6). */
  completedWorkouts: number;
  /** Workouts in one run of `program`, or `null` when unmatched. */
  expectedWorkouts: number | null;
  /** `null` when unmatched: the lifter picks it. */
  status: StretchStatus | null;
  reasons: {
    start: StretchStartReason;
    program: StretchProgramReason;
    status: StretchStatusReason;
  };
}

/** A single-lift session inside a break, left out of every stretch for the lifter to file (decision 5). */
export interface LoneSession<T> {
  session: { date: Date; rows: T[] };
  /** Days since the session before it, or `null` when it's the file's first. */
  daysAfterPrevious: number | null;
  /** Days until the session after it, or `null` when it's the file's last. */
  daysBeforeNext: number | null;
}

/** Where a file's macrocycle numbers disagree with its dates (decision 8). Indexes are into `stretches`. */
export type FileNumberConflict =
  | { kind: 'gap-inside-number'; stretch: number; from: Date; to: Date; days: number }
  | { kind: 'numbers-overlap'; stretches: [number, number] };

export interface SegmentedLiftHistory<T> {
  /** In start-date order. */
  stretches: HistoryStretch<T>[];
  lone: LoneSession<T>[];
  /** Rows with no date, never guessed into a stretch. */
  unplaced: T[];
  conflicts: FileNumberConflict[];
}

interface Session<T> {
  date: Date;
  rows: T[];
  /** liftKey → the lift as first spelled. */
  lifts: Map<string, string>;
  /** The first non-blank `Program` cell, trimmed. */
  programValue?: string;
  workoutNums: number[];
}

function isValidDate(date: Date | null | undefined): date is Date {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function sameProgramValue(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function toSessions<T extends LiftHistoryRow>(rows: readonly T[]): Session<T>[] {
  const byDay = new Map<number, Session<T>>();
  for (const row of rows) {
    if (!isValidDate(row.date)) continue;
    const date = toUTCMidnight(row.date);
    let session = byDay.get(date.getTime());
    if (!session) {
      session = { date, rows: [], lifts: new Map(), workoutNums: [] };
      byDay.set(date.getTime(), session);
    }
    session.rows.push(row);
    const key = liftKey(row.lift);
    if (!session.lifts.has(key)) session.lifts.set(key, row.lift.trim());
    const program = row.program?.trim();
    if (program && session.programValue === undefined) session.programValue = program;
    if (typeof row.workoutNum === 'number' && Number.isFinite(row.workoutNum)) {
      session.workoutNums.push(row.workoutNum);
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Decision 5, as the owner settled it for #1172: a single-lift session is lone when it hides
 * a break (each side is 14 days or less but the two together are more) or stands apart on
 * both sides. A session at the file's start or end is lone when its one neighbour is more
 * than 14 days away. With one side over 14 days and the other not, the break shows anyway
 * and the session stays with the run it's next to.
 */
function isLone<T>(sessions: readonly Session<T>[], i: number): boolean {
  const session = sessions[i];
  if (!session || session.lifts.size !== 1) return false;
  const prev = sessions[i - 1];
  const next = sessions[i + 1];
  if (prev && next) {
    const before = daysBetween(prev.date, session.date);
    const after = daysBetween(session.date, next.date);
    if (before + after <= BREAK_DAYS) return false;
    return (before <= BREAK_DAYS && after <= BREAK_DAYS) || (before > BREAK_DAYS && after > BREAK_DAYS);
  }
  const neighbour = prev ?? next;
  return neighbour !== undefined && Math.abs(daysBetween(neighbour.date, session.date)) > BREAK_DAYS;
}

interface Draft<T> {
  sessions: Session<T>[];
  start: StretchStartReason;
  fileMacrocycleNum?: number;
}

class Segmenter<T extends LiftHistoryRow> {
  private readonly programs: readonly KnownProgram[];
  /** Every lift some known program contains. A lift outside them all never splits a run. */
  private readonly knownLifts: ReadonlySet<string>;
  private readonly fileNumbersWorkouts: boolean;

  constructor(
    private readonly sessions: readonly Session<T>[],
    private readonly options: SegmentLiftHistoryOptions,
  ) {
    const custom = [...(options.customPrograms ?? [])].sort((a, b) =>
      (a.name ?? a.id).localeCompare(b.name ?? b.id),
    );
    this.programs = [...BUILT_IN_KNOWN_PROGRAMS, ...custom];
    this.knownLifts = new Set(this.programs.flatMap((p) => [...p.lifts]));
    this.fileNumbersWorkouts =
      sessions.length > 0 && sessions.every((s) => s.workoutNums.length === s.rows.length);
  }

  private knownLiftKeys(sessions: readonly Session<T>[]): Set<string> {
    const keys = new Set<string>();
    for (const s of sessions) for (const key of s.lifts.keys()) if (this.knownLifts.has(key)) keys.add(key);
    return keys;
  }

  private columnValue(sessions: readonly Session<T>[]): string | undefined {
    return sessions.find((s) => s.programValue !== undefined)?.programValue;
  }

  /** The program a draft is following so far: its column's, else its known lifts' match. */
  private provisionalProgram(sessions: readonly Session<T>[]): KnownProgram | undefined {
    const value = this.columnValue(sessions);
    const named = value === undefined ? undefined : programNamedBy(value, this.programs);
    if (named) return named;
    return matchProgramForLifts(this.knownLiftKeys(sessions), this.programs, this.options.sourceProgram)
      ?.program;
  }

  private completedWorkouts(sessions: readonly Session<T>[]): number {
    if (!this.fileNumbersWorkouts) return sessions.length;
    return new Set(sessions.flatMap((s) => s.workoutNums)).size;
  }

  /** Why `next` can't continue `draft`, or `null` when it does (decisions 4, 6, 7 and 9). */
  private boundary(draft: Draft<T>, next: Session<T>): StretchStartReason | null {
    const last = draft.sessions[draft.sessions.length - 1];
    if (!last) return null;
    const days = daysBetween(last.date, next.date);
    if (days > BREAK_DAYS) return { kind: 'gap', days };

    const program = this.provisionalProgram(draft.sessions);
    if (program && program.workoutCount > 0 && this.completedWorkouts(draft.sessions) >= program.workoutCount) {
      return { kind: 'previous-run-finished' };
    }

    const current = this.columnValue(draft.sessions);
    if (current !== undefined && next.programValue !== undefined) {
      if (!sameProgramValue(current, next.programValue)) {
        return { kind: 'program-column-changed', from: current, to: next.programValue };
      }
    } else if (current === undefined && next.programValue === undefined) {
      // The stretch so far may fit several programs (Leangains and RPT share most lifts), so a
      // lift starts a new stretch only when no program it fits has it. A move to a program
      // whose lifts are a subset of the current one can't show here (decision 9).
      const before = this.knownLiftKeys(draft.sessions);
      const fitting = programsContaining(before, this.programs);
      if (before.size > 0 && fitting.length > 0) {
        const outside = [...this.knownLiftKeys([next])].filter(
          (key) => !fitting.some((p) => p.lifts.has(key)),
        );
        if (outside.length > 0) {
          return { kind: 'lift-outside-program', lifts: outside.map((key) => next.lifts.get(key) ?? key) };
        }
      }
    }

    if (this.fileNumbersWorkouts) {
      const from = Math.max(...last.workoutNums);
      const to = Math.min(...next.workoutNums);
      if (to < from) return { kind: 'workout-number-fell-back', from, to };
    }
    return null;
  }

  byDates(): Draft<T>[] {
    const drafts: Draft<T>[] = [];
    for (const session of this.sessions) {
      const current = drafts[drafts.length - 1];
      if (!current) {
        drafts.push({ sessions: [session], start: { kind: 'first-session' } });
        continue;
      }
      const reason = this.boundary(current, session);
      if (reason) drafts.push({ sessions: [session], start: reason });
      else current.sessions.push(session);
    }
    return drafts;
  }

  /** Decision 8: one stretch per file program and number, whatever the dates say. */
  byFileNumbers(rows: readonly T[]): Draft<T>[] {
    const groups = new Map<string, { macrocycleNum: number; rows: T[] }>();
    for (const row of rows) {
      if (!isValidDate(row.date) || typeof row.macrocycleNum !== 'number') continue;
      const key = `${(row.program ?? '').trim().toLowerCase()}\u0000${row.macrocycleNum}`;
      const group = groups.get(key) ?? { macrocycleNum: row.macrocycleNum, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => ({
        sessions: toSessions(group.rows),
        start: { kind: 'file-macrocycle' as const, macrocycleNum: group.macrocycleNum },
        fileMacrocycleNum: group.macrocycleNum,
      }))
      .sort((a, b) => (a.sessions[0]?.date.getTime() ?? 0) - (b.sessions[0]?.date.getTime() ?? 0));
  }

  private resolveProgram(sessions: readonly Session<T>[]): {
    program: KnownProgram | undefined;
    id: string;
    reason: StretchProgramReason;
    outside: string[];
    candidate?: string;
  } {
    const allLifts = new Map<string, string>();
    for (const s of sessions) for (const [key, name] of s.lifts) if (!allLifts.has(key)) allLifts.set(key, name);
    const outsideOf = (program: KnownProgram) =>
      [...allLifts].filter(([key]) => !program.lifts.has(key)).map(([, name]) => name);

    const value = this.columnValue(sessions);
    const named = value === undefined ? undefined : programNamedBy(value, this.programs);
    if (named) {
      return { program: named, id: named.id, reason: { kind: 'column', value: value ?? named.id }, outside: outsideOf(named) };
    }
    const match = matchProgramForLifts(allLifts.keys(), this.programs, this.options.sourceProgram);
    if (match) {
      return { program: match.program, id: match.program.id, reason: { kind: 'lifts', tiedWith: match.tiedWith }, outside: [] };
    }
    // Unmatched: stored under the Source program (decision 9). A lift in no known program
    // doesn't split the run, but the lifter confirms it progresses like the rest before the
    // stretch counts as the program its other lifts match.
    const candidate = matchProgramForLifts(this.knownLiftKeys(sessions), this.programs, this.options.sourceProgram)?.program;
    const source = this.programs.find((p) => p.id === this.options.sourceProgram);
    const reference = candidate ?? source;
    return {
      program: undefined,
      id: this.options.sourceProgram,
      reason: { kind: 'source' },
      outside: reference ? outsideOf(reference) : [...allLifts.values()],
      ...(candidate ? { candidate: candidate.id } : {}),
    };
  }

  build(drafts: readonly Draft<T>[]): HistoryStretch<T>[] {
    const resolved = drafts.map((draft) => ({ draft, ...this.resolveProgram(draft.sessions) }));
    return resolved.map(({ draft, program, id, reason, outside, candidate }, i) => {
      const sessions = draft.sessions;
      const first = sessions[0];
      const last = sessions[sessions.length - 1];
      if (!first || !last) throw new Error('A stretch has at least one session.');
      const matchedProgram = outside.length === 0 ? program : undefined;
      const matched = matchedProgram !== undefined;
      const completed = this.completedWorkouts(sessions);
      const next = resolved[i + 1];
      const { status, statusReason } = matchedProgram
        ? this.status(matchedProgram, completed, last.date, first.date, next ? next.id === id : undefined)
        : { status: null, statusReason: { kind: 'unmatched' } as const };
      return {
        program: id,
        matched,
        liftsOutsideProgram: matched ? [] : outside,
        ...(candidate !== undefined && !matched ? { candidateProgram: candidate } : {}),
        ...(draft.fileMacrocycleNum !== undefined ? { fileMacrocycleNum: draft.fileMacrocycleNum } : {}),
        startDate: first.date,
        endDate: last.date,
        sessions: sessions.map((s, n) => ({
          date: s.date,
          rows: s.rows,
          workoutNum: this.fileNumbersWorkouts ? Math.min(...s.workoutNums) : n + 1,
        })),
        completedWorkouts: completed,
        expectedWorkouts: matchedProgram ? matchedProgram.workoutCount : null,
        status,
        reasons: { start: draft.start, program: reason, status: statusReason },
      };
    });
  }

  /**
   * Decisions 6 and 7. `nextIsSameProgram` is `undefined` for the file's last stretch.
   * Every stretch but the last is followed by a restart or a different program, so one with
   * workouts left is `abandoned`, which wins over `overran`.
   */
  private status(
    program: KnownProgram,
    completed: number,
    lastDate: Date,
    firstDate: Date,
    nextIsSameProgram: boolean | undefined,
  ): { status: StretchStatus; statusReason: StretchStatusReason } {
    if (completed >= program.workoutCount) {
      return { status: 'completed', statusReason: { kind: 'all-workouts-done' } };
    }
    if (nextIsSameProgram !== undefined) {
      return {
        status: 'abandoned',
        statusReason: { kind: nextIsSameProgram ? 'next-is-restart' : 'next-is-different-program' },
      };
    }
    const importDate = toUTCMidnight(this.options.importDate);
    const daysBeforeImport = daysBetween(lastDate, importDate);
    if (daysBeforeImport > BREAK_DAYS) {
      return { status: 'abandoned', statusReason: { kind: 'last-session-stale', daysBeforeImport } };
    }
    const daysSinceStart = daysBetween(firstDate, importDate);
    const weeksSinceStart = Math.floor(daysSinceStart / 7);
    return daysSinceStart >= program.lengthWeeks * 7
      ? { status: 'overran', statusReason: { kind: 'past-expected-length', weeksSinceStart } }
      : { status: 'in-progress', statusReason: { kind: 'inside-expected-length', weeksSinceStart } };
  }
}

function fileNumberConflicts<T>(stretches: readonly HistoryStretch<T>[]): FileNumberConflict[] {
  const conflicts: FileNumberConflict[] = [];
  stretches.forEach((stretch, i) => {
    for (let n = 1; n < stretch.sessions.length; n++) {
      const from = stretch.sessions[n - 1]?.date;
      const to = stretch.sessions[n]?.date;
      if (!from || !to) continue;
      const days = daysBetween(from, to);
      if (days > BREAK_DAYS) conflicts.push({ kind: 'gap-inside-number', stretch: i, from, to, days });
    }
  });
  stretches.forEach((a, i) => {
    stretches.forEach((b, j) => {
      if (j <= i || a.program !== b.program) return;
      if (a.startDate.getTime() <= b.endDate.getTime() && b.startDate.getTime() <= a.endDate.getTime()) {
        conflicts.push({ kind: 'numbers-overlap', stretches: [i, j] });
      }
    });
  });
  return conflicts;
}

/**
 * Groups imported lift history into suggested macrocycles from its dates.
 *
 * - A gap of more than {@link BREAK_DAYS} days between sessions, a finished run, a change in
 *   the file's `Program` column, a lift outside every program the stretch so far fits, or a
 *   file workout number falling back starts a new stretch.
 * - A file with macrocycle numbers on every dated row keeps its own groupings instead, and
 *   `conflicts` reports where they disagree with the dates.
 * - Single-lift sessions inside a break are returned in `lone`, outside every stretch.
 * - Rows with no date are returned in `unplaced`.
 */
export function segmentLiftHistory<T extends LiftHistoryRow>(
  rows: readonly T[],
  options: SegmentLiftHistoryOptions,
): SegmentedLiftHistory<T> {
  const unplaced = rows.filter((row) => !isValidDate(row.date));
  const dated = rows.filter((row) => isValidDate(row.date));
  const fileNumbersMacrocycles =
    dated.length > 0 && dated.every((row) => typeof row.macrocycleNum === 'number' && Number.isFinite(row.macrocycleNum));

  const sessions = toSessions(dated);

  if (fileNumbersMacrocycles) {
    // The file has already placed every session, so none is flagged as lone (decision 8).
    const segmenter = new Segmenter(sessions, options);
    const stretches = segmenter.build(segmenter.byFileNumbers(dated));
    return { stretches, lone: [], unplaced, conflicts: fileNumberConflicts(stretches) };
  }

  const lone: LoneSession<T>[] = [];
  const kept: Session<T>[] = [];
  sessions.forEach((session, i) => {
    if (!isLone(sessions, i)) {
      kept.push(session);
      return;
    }
    const prev = sessions[i - 1];
    const next = sessions[i + 1];
    lone.push({
      session: { date: session.date, rows: session.rows },
      daysAfterPrevious: prev ? daysBetween(prev.date, session.date) : null,
      daysBeforeNext: next ? daysBetween(session.date, next.date) : null,
    });
  });

  const segmenter = new Segmenter(kept, options);
  return { stretches: segmenter.build(segmenter.byDates()), lone, unplaced, conflicts: [] };
}
