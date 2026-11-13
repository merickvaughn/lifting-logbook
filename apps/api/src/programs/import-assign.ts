import { BadRequestException } from '@nestjs/common';
import {
  AssignProgramOption,
  AssignSession,
  AssignStretch,
  ImportAssignResponse,
} from '@lifting-logbook/types';
import {
  BUILT_IN_KNOWN_PROGRAMS,
  toUTCMidnight,
  type HistorySession,
  type HistoryStretch,
  type KnownProgram,
  type LiftHistoryRecord,
  type SegmentedLiftHistory,
  type TrainingMax,
} from '@lifting-logbook/core';
import type { RepositoryBundle } from '../ports/factory';

/**
 * Whether the import wizard's Assign step is on (#1253, proposal Rollout step 2). Off unless
 * `IMPORT_ASSIGN_ENABLED` is `true`, and read per request so a test can set it.
 *
 * Leave it off until all of #1173 has merged. It already relaxes the preview (no number
 * columns or blank number cells needed, rows with no date counted), but until #1254 the
 * commit still rejects them, so today's wizard would pass a file at Review that it can't
 * import.
 */
export function importAssignEnabled(): boolean {
  return process.env.IMPORT_ASSIGN_ENABLED === 'true';
}

const DAY_MS = 86_400_000;

/**
 * The import date statuses are judged against: the lifter's local calendar day at UTC
 * midnight, which the client sends as `YYYY-MM-DD`. The server keeps no timezone, so it takes
 * any day within one of its own UTC day, and its own day when none is sent.
 */
export function assignImportDate(today: string | undefined, now: Date = new Date()): Date {
  const serverDay = toUTCMidnight(now);
  if (today === undefined || today === '') return serverDay;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(today) ? new Date(`${today}T00:00:00Z`) : new Date(NaN);
  // A day past the month's end (`2026-02-30`) rolls into the next month rather than failing.
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== today) {
    throw new BadRequestException('today must be a calendar date, YYYY-MM-DD');
  }
  if (Math.abs(day.getTime() - serverDay.getTime()) > DAY_MS) {
    throw new BadRequestException(`today ${today} is more than a day from the server's date. Check your device's clock.`);
  }
  return day;
}

/** The programs a stretch can be given, built-ins first. */
export function assignProgramOptions(customPrograms: readonly KnownProgram[]): AssignProgramOption[] {
  return [
    ...BUILT_IN_KNOWN_PROGRAMS.map((p) => ({ id: p.id, name: null, workouts: p.workoutCount, weeks: p.lengthWeeks })),
    // A custom program is open-ended (#1172), so it has no length to run past.
    ...customPrograms.map((p) => ({ id: p.id, name: p.name ?? p.id, workouts: null, weeks: p.lengthWeeks })),
  ];
}

/**
 * How the one-rep-max rows split to training maxes would land (proposal decision 10). Each
 * belongs to the program of the stretch covering its date, else the Source program. For each
 * program and lift, the newest row is the one the import would write: it changes the max
 * unless it matches it, and it's skipped when it's older than the max.
 */
export async function splitMaxCounts(
  splitMaxes: readonly TrainingMax[],
  stretches: ReadonlyArray<Pick<HistoryStretch<unknown>, 'program' | 'startDate' | 'endDate'>>,
  sourceProgram: string,
  repos: Pick<RepositoryBundle, 'trainingMax'>,
): Promise<{ changes: number; olderThanCurrent: number }> {
  const programOf = (date: Date) =>
    stretches.find((s) => s.startDate.getTime() <= date.getTime() && date.getTime() <= s.endDate.getTime())?.program ??
    sourceProgram;
  // The newest row for each program and lift. Rows dated the same day keep the first in the
  // file, as `latestTrainingMaxFirst` does for the commit.
  const newest = new Map<string, { program: string; max: TrainingMax }>();
  for (const max of splitMaxes) {
    const program = programOf(max.dateUpdated);
    const key = `${program}|${max.lift}`;
    const kept = newest.get(key);
    if (!kept || max.dateUpdated.getTime() > kept.max.dateUpdated.getTime()) newest.set(key, { program, max });
  }

  const current = new Map<string, Map<string, TrainingMax>>();
  let changes = 0;
  let olderThanCurrent = 0;
  for (const { program, max } of newest.values()) {
    let byLift = current.get(program);
    if (!byLift) {
      byLift = new Map((await repos.trainingMax.getTrainingMaxes(program)).map((m) => [m.lift, m]));
      current.set(program, byLift);
    }
    const stored = byLift.get(max.lift);
    if (stored && max.dateUpdated.getTime() < stored.dateUpdated.getTime()) olderThanCurrent++;
    else if (!stored || stored.weight !== max.weight) changes++;
  }
  return { changes, olderThanCurrent };
}

// `YYYY-MM-DD`: lift-record dates are UTC midnight.
const ymd = (date: Date) => date.toISOString().slice(0, 10);

function assignSession(
  session: { date: Date; rows: readonly LiftHistoryRecord[] },
  workoutNum: number | null,
  liftNames: ReadonlyMap<string, string>,
): AssignSession {
  const lifts = [...new Set(session.rows.map((r) => r.lift))].map((lift) => liftNames.get(lift) ?? lift);
  return { date: ymd(session.date), workoutNum, lifts, sets: session.rows.length };
}

/** A session with no workout number of its own: the file's number on its rows, if one. */
function rowSession(session: { date: Date; rows: readonly LiftHistoryRecord[] }, liftNames: ReadonlyMap<string, string>) {
  return assignSession(session, session.rows.find((r) => r.workoutNum !== null)?.workoutNum ?? null, liftNames);
}

/** Groups rows by date into sessions, oldest first. */
function sessionsOf(rows: readonly LiftHistoryRecord[]): Array<{ date: Date; rows: LiftHistoryRecord[] }> {
  const byDate = new Map<number, LiftHistoryRecord[]>();
  for (const row of rows) {
    const time = (row.date as Date).getTime();
    const list = byDate.get(time);
    if (list) list.push(row);
    else byDate.set(time, [row]);
  }
  return [...byDate.entries()].sort(([a], [b]) => a - b).map(([time, list]) => ({ date: new Date(time), rows: list }));
}

function assignStretch(
  stretch: HistoryStretch<LiftHistoryRecord>,
  liftNames: ReadonlyMap<string, string>,
): AssignStretch {
  const named = (lifts: readonly string[]) => lifts.map((lift) => liftNames.get(lift) ?? lift);
  const start = stretch.reasons.start;
  return {
    program: stretch.program,
    matched: stretch.matched,
    liftsOutsideProgram: named(stretch.liftsOutsideProgram),
    candidateProgram: stretch.candidateProgram ?? null,
    fileMacrocycleNum: stretch.fileMacrocycleNum ?? null,
    startDate: ymd(stretch.startDate),
    endDate: ymd(stretch.endDate),
    sessions: stretch.sessions.map((s: HistorySession<LiftHistoryRecord>) => assignSession(s, s.workoutNum, liftNames)),
    completedWorkouts: stretch.completedWorkouts,
    expectedWorkouts: stretch.expectedWorkouts,
    status: stretch.status,
    reasons: {
      start:
        start.kind === 'lift-outside-program'
          ? { kind: start.kind, lifts: named(start.lifts) }
          : start.kind === 'set-order-changed'
            ? { kind: start.kind, lifts: start.lifts.map((c) => ({ ...c, lift: liftNames.get(c.lift) ?? c.lift })) }
            : start,
      program: stretch.reasons.program,
      status: stretch.reasons.status,
    },
  };
}

/** The `mode=assign` response for a segmented file. Lift ids become display names. */
export function assignResponse(
  segmented: SegmentedLiftHistory<LiftHistoryRecord>,
  extra: {
    importDate: Date;
    undatedRows: number;
    exported: boolean;
    programs: AssignProgramOption[];
    split?: { changes: number; olderThanCurrent: number };
  },
  liftNames: ReadonlyMap<string, string>,
): ImportAssignResponse {
  const nonCycle = sessionsOf(segmented.nonCycle).map((s) => rowSession(s, liftNames));
  const unnumbered = sessionsOf(segmented.unnumbered).map((s) => rowSession(s, liftNames));
  const stretches = segmented.stretches.map((s) => assignStretch(s, liftNames));
  return {
    importDate: ymd(extra.importDate),
    sessions:
      stretches.reduce((n, s) => n + s.sessions.length, 0) + segmented.lone.length + nonCycle.length + unnumbered.length,
    stretches,
    lone: segmented.lone.map((l) => ({
      session: rowSession(l.session, liftNames),
      daysAfterPrevious: l.daysAfterPrevious,
      daysBeforeNext: l.daysBeforeNext,
    })),
    nonCycle,
    unnumbered,
    conflicts: segmented.conflicts.map((c) =>
      c.kind === 'gap-inside-number' ? { ...c, from: ymd(c.from), to: ymd(c.to) } : c,
    ),
    undatedRows: extra.undatedRows,
    exported: extra.exported,
    programs: extra.programs,
    ...(extra.split ? { split: extra.split } : {}),
  };
}
