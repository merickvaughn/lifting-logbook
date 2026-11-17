import { BadRequestException } from '@nestjs/common';
import {
  AssignContinueOffer,
  AssignLift,
  AssignProgramOption,
  AssignSession,
  AssignStoredPlacement,
  AssignStretch,
  ImportAssignResponse,
  isLiftProgressionType,
  MACROCYCLE_STATUSES,
  MacrocycleStatus,
} from '@lifting-logbook/types';
import {
  BUILT_IN_KNOWN_PROGRAMS,
  liftKey,
  progressionLookup,
  toUTCMidnight,
  type HistorySession,
  type HistoryStretch,
  type KnownProgram,
  type LiftHistoryRecord,
  type ProgressionSettings,
  type SegmentedLiftHistory,
  type TrainingMax,
} from '@lifting-logbook/core';
import type { RepositoryBundle } from '../ports/factory';

/**
 * Whether the import wizard's Assign step is on (#1253, proposal Rollout step 2). Off unless
 * `IMPORT_ASSIGN_ENABLED` is `true`, and read per request so a test can set it.
 *
 * Leave it off until all of #1173 has merged. It already relaxes the preview (no number
 * columns or blank number cells needed, rows with no date counted), and since #1254 the
 * commit accepts those files only with a `breakdown`, which the wizard doesn't send until
 * its Assign step lands, so today's wizard would pass a file at Review that it can't import.
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
 * Each lift in `lifts` (stored spellings) once, by display name (#1212): the programs that plan
 * it, and the progression it follows with no program row, which Assign preselects for a lift
 * its stretch's program doesn't plan. A change is saved to the lift's own `lift_metadata` row
 * when it has one, under whatever spelling it was saved, so the lift doesn't get a second row;
 * else under its display name, the spelling the lift editor reads it by.
 */
export function assignLifts(
  lifts: Iterable<string>,
  programs: readonly KnownProgram[],
  settings: ProgressionSettings,
  liftNames: ReadonlyMap<string, string>,
): AssignLift[] {
  const lookup = progressionLookup(settings);
  const byName = new Map<string, AssignLift>();
  for (const lift of lifts) {
    const name = liftNames.get(lift) ?? lift;
    if (byName.has(name)) continue;
    const key = liftKey(lift);
    const { type } = lookup.resolve(lift);
    // With no row, the type comes from a lift, a default or the catalog, none of which can be
    // `rpe`. If one ever were, Assign would preselect a type `updateMaxes` doesn't use.
    if (!isLiftProgressionType(type)) throw new Error(`A lift's progression resolved to ${type} with no program row`);
    byName.set(name, {
      name,
      metadataLift: lookup.liftMetaFor(lift)?.lift ?? name,
      programs: programs.filter((p) => p.lifts.has(key)).map((p) => p.id),
      progression: type,
    });
  }
  return [...byName.values()];
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
  const { changes, olderThanCurrent } = await planSplitMaxes(splitMaxes, programCoveringDate(stretches, sourceProgram), repos);
  return { changes, olderThanCurrent };
}

/**
 * The program of the first stretch whose dates span a date, else `fallback` (decision 10). Assign
 * and the commit both place split rows through this.
 */
export function programCoveringDate(
  stretches: ReadonlyArray<{ program: string; startDate: Date; endDate: Date }>,
  fallback: string,
): (date: Date) => string {
  return (date) =>
    stretches.find((s) => s.startDate.getTime() <= date.getTime() && date.getTime() <= s.endDate.getTime())?.program ??
    fallback;
}

/** One program's share of a split: its stored maxes and the newest row per lift to write. */
export interface ProgramSplit {
  existing: TrainingMax[];
  writes: TrainingMax[];
}

/**
 * Where the one-rep-max rows split to training maxes land (decision 10): each row goes to the
 * program `programOf` gives its date, and for each program and lift only the newest row is
 * written, unless it's older than that program's current max, when it's skipped and counted.
 * `changes` counts the writes that change a max.
 */
export async function planSplitMaxes(
  splitMaxes: readonly TrainingMax[],
  programOf: (date: Date) => string,
  repos: Pick<RepositoryBundle, 'trainingMax'>,
): Promise<{ byProgram: Map<string, ProgramSplit>; changes: number; olderThanCurrent: number }> {
  // The newest row for each program and lift. Rows dated the same day keep the first in the
  // file, as `latestTrainingMaxFirst` does for the commit.
  const newest = new Map<string, { program: string; max: TrainingMax }>();
  for (const max of splitMaxes) {
    const program = programOf(max.dateUpdated);
    const key = `${program}|${max.lift}`;
    const kept = newest.get(key);
    if (!kept || max.dateUpdated.getTime() > kept.max.dateUpdated.getTime()) newest.set(key, { program, max });
  }

  const byProgram = new Map<string, ProgramSplit>();
  let changes = 0;
  let olderThanCurrent = 0;
  for (const { program, max } of newest.values()) {
    let split = byProgram.get(program);
    if (!split) {
      split = { existing: await repos.trainingMax.getTrainingMaxes(program), writes: [] };
      byProgram.set(program, split);
    }
    const stored = split.existing.find((m) => m.lift === max.lift);
    if (stored && max.dateUpdated.getTime() < stored.dateUpdated.getTime()) {
      olderThanCurrent++;
      continue;
    }
    split.writes.push(max);
    if (!stored || stored.weight !== max.weight) changes++;
  }
  return { byProgram, changes, olderThanCurrent };
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

/** A row as Assign reads it: an export's rows also carry the `Status` the assign parse read. */
export type AssignRecord = LiftHistoryRecord & { status?: string };

/**
 * An exported file's `Status` for a stretch's rows (#1254, decision 22): the one value its rows
 * carry, else null. The assign parse reads it onto each row, already checked against the statuses.
 */
function fileStatusOf(rows: ReadonlyArray<{ status?: string }>): MacrocycleStatus | null {
  const values = new Set(rows.map((row) => row.status ?? ''));
  values.delete('');
  const [only] = values;
  return values.size === 1 && (MACROCYCLE_STATUSES as readonly string[]).includes(only ?? '') ? (only as MacrocycleStatus) : null;
}

function assignStretch(
  stretch: HistoryStretch<AssignRecord>,
  stored: AssignStoredPlacement,
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
    fileGroup: stretch.fileGroup ?? null,
    startDate: ymd(stretch.startDate),
    endDate: ymd(stretch.endDate),
    sessions: stretch.sessions.map((s: HistorySession<AssignRecord>) => assignSession(s, s.workoutNum, liftNames)),
    completedWorkouts: stretch.completedWorkouts,
    expectedWorkouts: stretch.expectedWorkouts,
    status: stretch.status,
    fileStatus: fileStatusOf(stretch.sessions.flatMap((s) => s.rows)),
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
    stored,
  };
}

/** The `mode=assign` response for a segmented file. Lift ids become display names. */
export function assignResponse(
  segmented: SegmentedLiftHistory<AssignRecord>,
  extra: {
    importDate: Date;
    undatedRows: number;
    exported: boolean;
    programs: AssignProgramOption[];
    /** The file's lifts ({@link assignLifts}). */
    lifts: AssignLift[];
    split?: { changes: number; olderThanCurrent: number };
    /** Each stretch's placement among the stored macrocycles, in `segmented.stretches` order (#1255). */
    stored: readonly AssignStoredPlacement[];
    /** Who LLM suggestions would go to, or null when they're off (#1174). */
    suggestionsProvider: string | null;
    /** The offer to continue the last stretch as current (#1180), or null. */
    continueOffer: AssignContinueOffer | null;
    /** What replacing stored history would remove (#1182). */
    overwrite: ImportAssignResponse['overwrite'];
  },
  liftNames: ReadonlyMap<string, string>,
): ImportAssignResponse {
  const nonCycle = sessionsOf(segmented.nonCycle).map((s) => rowSession(s, liftNames));
  const unnumbered = sessionsOf(segmented.unnumbered).map((s) => rowSession(s, liftNames));
  const stretches = segmented.stretches.map((s, i) => {
    const stored = extra.stored[i];
    if (!stored) throw new Error(`mode=assign placed ${extra.stored.length} of ${segmented.stretches.length} stretches`);
    return assignStretch(s, stored, liftNames);
  });
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
    lifts: extra.lifts,
    ...(extra.split ? { split: extra.split } : {}),
    suggestions: extra.suggestionsProvider === null ? null : { provider: extra.suggestionsProvider },
    continue: extra.continueOffer,
    overwrite: extra.overwrite,
  };
}
