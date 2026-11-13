import { AssignStoredPlacement, NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import {
  BREAK_DAYS,
  HistoryStretch,
  KnownProgram,
  LiftHistoryRecord,
  classifyLiftRecordRows,
  isOpenEnded,
  suggestStretchStatus,
  toUTCMidnight,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';

/**
 * How an Assign stretch meets what's already stored (#1255, proposal decision 14). `mode=assign`
 * reports it and the commit acts on it, from the same rule, so the two can't disagree.
 *
 * - `already-imported`: the stretch has no row to create.
 * - `joins`: its new rows join a stored `imported` macrocycle of its program, taking its number.
 * - `overlaps`: its dates overlap stored macrocycles it can't join, so it forms its own.
 * - `new`: it forms its own macrocycle, overlapping nothing.
 */
export type StoredPlacement =
  | { kind: 'new' }
  | { kind: 'already-imported' }
  | { kind: 'joins'; macrocycle: MacrocycleRow; highestWorkout: number }
  | { kind: 'overlaps'; macrocycles: MacrocycleRow[] };

/** A stretch as {@link placeOnStored} reads it. */
export interface StretchToPlace {
  program: string;
  /** The first and last dates of all its rows, new or already stored. */
  span: { startDate: Date; endDate: Date };
  /** Its rows to create: their dates and the file's workout numbers (null or NaN for none). */
  creating: ReadonlyArray<{ date: Date; workoutNum: number | null }>;
}

const DAY_MS = 86_400_000;

/** A stored macrocycle's last day: its end date, else its start, or no end for a live one. */
function endOf(m: MacrocycleRow): number {
  if (m.endDate) return m.endDate.getTime();
  return m.origin === 'live' ? Infinity : m.startDate.getTime();
}

/**
 * Decision 14: where each stretch's new rows go. They join a stored `imported` macrocycle of the
 * stretch's program, which no other stretch has joined, when either
 *
 * - the stretch's dates overlap that macrocycle and no other stored one, as when a file has grown
 *   past what an earlier import of it stored; or
 * - they overlap none, and that macrocycle is the last thing before them, stored or in the file
 *   (decision 7: anything in between is a boundary), ending at most 14 days before (decision 4),
 *   with workouts left (decision 6: not `completed`, and fewer distinct workouts than its program
 *   has unless the program is open-ended), and the file's workout numbers don't fall back below
 *   its highest (decision 7's restart).
 *
 * A stretch overlapping anything else forms its own macrocycle and says what it overlaps. The
 * non-cycle macrocycle is never one of these.
 */
export async function placeOnStored(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>,
  stretches: readonly StretchToPlace[],
  programs: readonly KnownProgram[],
): Promise<StoredPlacement[]> {
  const stored = (await repos.macrocycle.listAll()).filter((m) => m.program !== NON_CYCLE_PROGRAM);
  const joined = new Set<string>();
  const placements: StoredPlacement[] = stretches.map(() => ({ kind: 'new' }));
  const order = stretches
    .map((stretch, i) => ({ stretch, i }))
    .sort((a, b) => a.stretch.span.startDate.getTime() - b.stretch.span.startDate.getTime());

  for (const { stretch, i } of order) {
    placements[i] = await placeOne(stretch, i);
  }
  return placements;

  async function placeOne(stretch: StretchToPlace, i: number): Promise<StoredPlacement> {
    if (stretch.creating.length === 0) return { kind: 'already-imported' };
    const start = stretch.span.startDate.getTime();
    const end = stretch.span.endDate.getTime();
    const joinable = (m: MacrocycleRow) => m.program === stretch.program && m.origin === 'imported' && !joined.has(m.id);
    const join = (macrocycle: MacrocycleRow, highestWorkout: number): StoredPlacement => {
      joined.add(macrocycle.id);
      return { kind: 'joins', macrocycle, highestWorkout };
    };

    const overlapping = stored.filter((m) => m.startDate.getTime() <= end && endOf(m) >= start);
    const [only] = overlapping;
    if (overlapping.length === 1 && only && joinable(only)) {
      return join(only, Math.max(0, ...(await repos.liftRecord.getLoggedWorkoutNums(only.program, only.macrocycleNum))));
    }
    if (overlapping.length > 0) return { kind: 'overlaps', macrocycles: overlapping };

    // The last thing before the stretch: a stored macrocycle, or another of the file's stretches.
    // On a tie the file's own stretch wins, since its boundary is the lifter's.
    let latest: { end: number; macrocycle: MacrocycleRow | null } | null = null;
    for (const m of stored) {
      if (endOf(m) < start && (!latest || endOf(m) > latest.end)) latest = { end: endOf(m), macrocycle: m };
    }
    for (const [j, other] of stretches.entries()) {
      const otherEnd = other.span.endDate.getTime();
      if (j !== i && otherEnd < start && (!latest || otherEnd >= latest.end)) latest = { end: otherEnd, macrocycle: null };
    }
    const previous = latest?.macrocycle;
    if (!previous || !joinable(previous) || (start - endOf(previous)) / DAY_MS > BREAK_DAYS) return { kind: 'new' };
    const logged = await repos.liftRecord.getLoggedWorkoutNums(previous.program, previous.macrocycleNum);
    const highest = Math.max(0, ...logged);
    const program = programs.find((p) => p.id === previous.program);
    const workoutsLeft =
      previous.status !== 'completed' && (!program || isOpenEnded(program) || logged.size < program.workoutCount);
    const fileNums = stretch.creating.map((r) => r.workoutNum).filter((n): n is number => n !== null && Number.isFinite(n));
    const fallsBack = fileNums.length > 0 && Math.min(...fileNums) < highest;
    return workoutsLeft && !fallsBack ? join(previous, highest) : { kind: 'new' };
  }
}

/**
 * `mode=assign`'s placements for the rules' stretches: their rows classified against what's
 * stored, under any program (decision 13), then placed as a commit of them would be.
 */
export async function placeSuggestedStretches(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>,
  stretches: ReadonlyArray<HistoryStretch<LiftHistoryRecord>>,
  programs: readonly KnownProgram[],
): Promise<AssignStoredPlacement[]> {
  const rows = stretches.flatMap((stretch, i) =>
    stretch.sessions.flatMap((session) =>
      session.rows.map((r) => ({
        r: { ...r, program: r.program ?? '', macrocycleNum: r.macrocycleNum ?? NaN, workoutNum: r.workoutNum ?? NaN },
        i,
      })),
    ),
  );
  const classified = classifyLiftRecordRows(rows, ({ r }) => r, await repos.liftRecord.findStoredSets(rows.map(({ r }) => r)));
  const creating = stretches.map((): Array<{ date: Date; workoutNum: number | null }> => []);
  for (const { kind, row } of classified) {
    if (kind === 'create') creating[row.i]?.push({ date: row.r.date, workoutNum: Number.isFinite(row.r.workoutNum) ? row.r.workoutNum : null });
  }
  const placements = await placeOnStored(
    repos,
    stretches.map((s, i) => ({ program: s.program, span: { startDate: s.startDate, endDate: s.endDate }, creating: creating[i] ?? [] })),
    programs,
  );
  return placements.map((p, i) => assignStoredPlacement(p, creating[i] ?? []));
}

/** A placement as `mode=assign` reports it, with the stretch's rows to create. */
export function assignStoredPlacement(
  placement: StoredPlacement,
  creating: ReadonlyArray<{ date: Date }>,
): AssignStoredPlacement {
  switch (placement.kind) {
    case 'joins':
      return {
        kind: 'joins',
        macrocycleNum: placement.macrocycle.macrocycleNum,
        newWorkouts: new Set(creating.map((r) => r.date.getTime())).size,
      };
    case 'overlaps':
      return {
        kind: 'overlaps',
        macrocycles: placement.macrocycles.map((m) => ({ program: m.program, macrocycleNum: m.macrocycleNum })),
      };
    default:
      return { kind: placement.kind };
  }
}

/**
 * Workout numbers for a joining stretch's new rows (decision 9): the file's where it has one,
 * else continuing from the macrocycle's highest, one per new session in date order.
 */
export function continuedWorkoutNums(
  creating: ReadonlyArray<{ date: Date; workoutNum: number | null }>,
  highestWorkout: number,
): Array<number> {
  const sessions = [...new Set(creating.map((r) => r.date.getTime()))].sort((a, b) => a - b);
  const position = new Map(sessions.map((t, n) => [t, highestWorkout + n + 1]));
  return creating.map((r) =>
    r.workoutNum !== null && Number.isFinite(r.workoutNum) ? r.workoutNum : (position.get(r.date.getTime()) ?? highestWorkout + 1),
  );
}

/**
 * Undo's recompute (decision 14): each of `ids` still holding lift records takes its dates from
 * them and, unless the lifter chose its status, the status the rules suggest from them as of
 * `today`. Returns the numbers of those left with none, for the caller to remove. A macrocycle that
 * isn't `imported`, or is gone, is left alone.
 */
export async function recomputeMacrocycles(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>,
  program: string,
  ids: readonly string[],
  programs: readonly KnownProgram[],
  today: Date,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const [rows, ranges] = await Promise.all([
    repos.macrocycle.list(program),
    repos.liftRecord.getMacrocycleDateRanges(program),
  ]);
  const known = programs.find((p) => p.id === program);
  const empty: number[] = [];
  let others: MacrocycleRow[] | null = null;
  for (const m of rows) {
    if (!ids.includes(m.id) || m.origin !== 'imported') continue;
    const range = ranges.get(m.macrocycleNum);
    if (!range) {
      empty.push(m.macrocycleNum);
      continue;
    }
    const startDate = toUTCMidnight(range.first);
    const endDate = toUTCMidnight(range.last);
    let status = m.status;
    if (!m.statusChosen && known) {
      others ??= (await repos.macrocycle.listAll()).filter((o) => o.program !== NON_CYCLE_PROGRAM);
      const after = others
        .filter((o) => o.id !== m.id && o.startDate.getTime() > endDate.getTime())
        .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0];
      const completed = (await repos.liftRecord.getLoggedWorkoutNums(program, m.macrocycleNum)).size;
      status = suggestStretchStatus(known, {
        completed,
        firstDate: startDate,
        lastDate: endDate,
        next: after ? { program: after.program } : undefined,
        importDate: today,
      }).status;
    }
    await repos.macrocycle.update(m.id, { startDate, endDate, status });
  }
  return empty;
}
