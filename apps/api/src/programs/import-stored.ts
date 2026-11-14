import { AssignStoredPlacement, NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import {
  BREAK_DAYS,
  HistoryStretch,
  KnownProgram,
  LiftHistoryRecord,
  classifyLiftRecordRows,
  isOpenEnded,
  liftKey,
  suggestStretchStatus,
  toUTCMidnight,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';
import { ImportBatchRecord, StatusChoice } from '../ports/IImportBatchRepository';
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
  | { kind: 'joins'; macrocycle: MacrocycleRow; held: HeldWorkouts }
  | { kind: 'overlaps'; macrocycles: MacrocycleRow[] };

/** A stored macrocycle's workouts, read once when a stretch joins it. */
export interface HeldWorkouts {
  /** Each date it holds sets on, as a UTC-midnight time, and that date's workout number. */
  byDate: ReadonlyMap<number, number>;
  /** Its highest workout number, or 0 with none. */
  highest: number;
  /** How many distinct workouts it holds. */
  count: number;
}

/** A stretch's rows to create: their dates and the file's workout numbers (null for none). */
type Creating = Array<{ date: Date; workoutNum: number | null }>;

/** A stretch as {@link placeOnStored} reads it. */
export interface StretchToPlace {
  program: string;
  /** The first and last dates of all its rows, new or already stored. */
  span: { startDate: Date; endDate: Date };
  /** Its rows to create: their dates and the file's workout numbers (null for none). */
  creating: ReadonlyArray<{ date: Date; workoutNum: number | null }>;
}

const DAY_MS = 86_400_000;

/** A stored macrocycle with the days it covers: its stored dates, widened by its sets' dates. */
interface StoredSpan {
  macrocycle: MacrocycleRow;
  start: number;
  /** Its end date or, with none (a `live` or just-started one), its last set, else its start. */
  end: number;
}

/**
 * Every stored macrocycle but the non-cycle one, with its span. A `legacy` macrocycle can hold sets
 * outside its stored dates, and a `live` one has no end date until it closes, so both are read
 * from their sets: one grouped query per program.
 */
async function storedSpans(repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>): Promise<StoredSpan[]> {
  const stored = (await repos.macrocycle.listAll()).filter((m) => m.program !== NON_CYCLE_PROGRAM);
  const programs = [...new Set(stored.map((m) => m.program))];
  const ranges = new Map(
    await Promise.all(programs.map(async (p) => [p, await repos.liftRecord.getMacrocycleDateRanges(p)] as const)),
  );
  return stored.map((macrocycle) => {
    const range = ranges.get(macrocycle.program)?.get(macrocycle.macrocycleNum);
    const start = macrocycle.startDate.getTime();
    return {
      macrocycle,
      start: range ? Math.min(start, toUTCMidnight(range.first).getTime()) : start,
      end: Math.max(macrocycle.endDate?.getTime() ?? start, range ? toUTCMidnight(range.last).getTime() : start),
    };
  });
}

/** The workouts a stored macrocycle holds, from its sets. */
async function heldWorkouts(repos: Pick<RepositoryBundle, 'liftRecord'>, m: MacrocycleRow): Promise<HeldWorkouts> {
  const byDate = new Map<number, number>();
  const nums = new Set<number>();
  for (const r of await repos.liftRecord.getLiftRecords(m.program, m.macrocycleNum)) {
    const date = toUTCMidnight(r.date).getTime();
    byDate.set(date, Math.min(byDate.get(date) ?? r.workoutNum, r.workoutNum));
    nums.add(r.workoutNum);
  }
  return { byDate, highest: Math.max(0, ...nums), count: nums.size };
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
 * "The last thing before" is the latest to end. On a tie the file's own stretch wins, since its
 * boundary is the lifter's. Between stored macrocycles ending the same day, one of the stretch's
 * program wins, then the later start, then the greater id, so every adapter places alike.
 *
 * A stretch overlapping anything else forms its own macrocycle and says what it overlaps. The
 * non-cycle macrocycle is never one of these. Returns each stretch with its placement, in the
 * order given.
 */
export async function placeOnStored<T extends StretchToPlace>(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>,
  stretches: readonly T[],
  programs: readonly KnownProgram[],
): Promise<Array<{ stretch: T; placement: StoredPlacement }>> {
  const stored = await storedSpans(repos);
  const joined = new Set<string>();
  const placed = new Map<T, StoredPlacement>();
  const byStart = [...stretches].sort((a, b) => a.span.startDate.getTime() - b.span.startDate.getTime());
  for (const stretch of byStart) placed.set(stretch, await placeOne(stretch));
  return stretches.map((stretch) => {
    const placement = placed.get(stretch);
    if (!placement) throw new Error('placeOnStored: a stretch went unplaced');
    return { stretch, placement };
  });

  async function placeOne(stretch: T): Promise<StoredPlacement> {
    if (stretch.creating.length === 0) return { kind: 'already-imported' };
    const start = stretch.span.startDate.getTime();
    const end = stretch.span.endDate.getTime();
    const joinable = (m: MacrocycleRow) => m.program === stretch.program && m.origin === 'imported' && !joined.has(m.id);
    const join = (macrocycle: MacrocycleRow, held: HeldWorkouts): StoredPlacement => {
      joined.add(macrocycle.id);
      return { kind: 'joins', macrocycle, held };
    };

    const overlapping = stored.filter((s) => s.start <= end && s.end >= start).map((s) => s.macrocycle);
    const [only] = overlapping;
    if (overlapping.length === 1 && only && joinable(only)) return join(only, await heldWorkouts(repos, only));
    if (overlapping.length > 0) return { kind: 'overlaps', macrocycles: overlapping };

    const before = stored.filter((s) => s.end < start).sort((a, b) => laterFirst(a, b, stretch.program))[0];
    const fileEnds = stretches.filter((o) => o !== stretch && o.span.endDate.getTime() < start).map((o) => o.span.endDate.getTime());
    if (!before || fileEnds.some((e) => e >= before.end)) return { kind: 'new' };
    const previous = before.macrocycle;
    if (!joinable(previous) || (start - before.end) / DAY_MS > BREAK_DAYS) return { kind: 'new' };
    const held = await heldWorkouts(repos, previous);
    const program = programs.find((p) => p.id === previous.program);
    const workoutsLeft =
      previous.status !== 'completed' && (!program || isOpenEnded(program) || held.count < program.workoutCount);
    const fileNums = stretch.creating.map((r) => r.workoutNum).filter((n): n is number => n !== null);
    const fallsBack = fileNums.length > 0 && Math.min(...fileNums) < held.highest;
    return workoutsLeft && !fallsBack ? join(previous, held) : { kind: 'new' };
  }
}

/** Sorts the stored macrocycle that ended last first, with {@link placeOnStored}'s tie rule. */
function laterFirst(a: StoredSpan, b: StoredSpan, program: string): number {
  if (a.end !== b.end) return b.end - a.end;
  const own = Number(b.macrocycle.program === program) - Number(a.macrocycle.program === program);
  if (own !== 0) return own;
  if (a.start !== b.start) return b.start - a.start;
  return b.macrocycle.id < a.macrocycle.id ? -1 : b.macrocycle.id > a.macrocycle.id ? 1 : 0;
}

/**
 * `mode=assign`'s placements for the rules' stretches, in their order: their rows classified
 * against what's stored, under any program (decision 13), then placed as a commit of them would be.
 */
export async function placeSuggestedStretches(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>,
  stretches: ReadonlyArray<HistoryStretch<LiftHistoryRecord>>,
  programs: readonly KnownProgram[],
): Promise<AssignStoredPlacement[]> {
  const toPlace = stretches.map((source): StretchToPlace & { source: typeof source; creating: Creating } => ({
    source,
    program: source.program,
    span: { startDate: source.startDate, endDate: source.endDate },
    creating: [],
  }));
  const rows = toPlace.flatMap((target) =>
    target.source.sessions.flatMap((session) =>
      session.rows.map((r) => ({
        r: { ...r, program: r.program ?? '', macrocycleNum: r.macrocycleNum ?? NaN, workoutNum: r.workoutNum ?? NaN },
        target,
      })),
    ),
  );
  const classified = classifyLiftRecordRows(rows, ({ r }) => r, await repos.liftRecord.findStoredSets(rows.map(({ r }) => r)));
  for (const { kind, row } of classified) {
    if (kind === 'create') row.target.creating.push({ date: row.r.date, workoutNum: Number.isFinite(row.r.workoutNum) ? row.r.workoutNum : null });
  }
  return (await placeOnStored(repos, toPlace, programs)).map(({ stretch, placement }) => assignStoredPlacement(placement, stretch.creating));
}

/** A placement as `mode=assign` reports it, with the stretch's rows to create. */
function assignStoredPlacement(placement: StoredPlacement, creating: ReadonlyArray<{ date: Date }>): AssignStoredPlacement {
  switch (placement.kind) {
    case 'joins':
      return {
        kind: 'joins',
        macrocycleNum: placement.macrocycle.macrocycleNum,
        newWorkouts: new Set(
          creating.map((r) => toUTCMidnight(r.date).getTime()).filter((t) => !placement.held.byDate.has(t)),
        ).size,
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
 * The workout number of a joining stretch's new row (decision 9), given all its new rows: the
 * file's where it has one. An unnumbered row takes its date's workout: the one the macrocycle
 * holds on that date, else the file's number on another of the new rows that day. The other new
 * dates continue in date order past the highest of the macrocycle's workouts and the file's
 * numbers, so no two sessions share a number.
 */
export function continuedWorkoutNum(
  creating: ReadonlyArray<{ date: Date; workoutNum: number | null }>,
  held: HeldWorkouts,
): (row: { date: Date; workoutNum: number }) => number {
  const dayOf = (r: { date: Date }) => toUTCMidnight(r.date).getTime();
  const fileByDate = new Map<number, number>();
  for (const r of creating) {
    // A day's lowest number, as Assign reports the session (#1256).
    if (r.workoutNum !== null && r.workoutNum < (fileByDate.get(dayOf(r)) ?? Infinity)) fileByDate.set(dayOf(r), r.workoutNum);
  }
  // Every file number counts, including a second one on a date (a double session).
  const fileNums = creating.flatMap((r) => (r.workoutNum === null ? [] : [r.workoutNum]));
  const highest = Math.max(held.highest, ...fileNums);
  const newDates = [
    ...new Set(creating.map(dayOf).filter((t) => !held.byDate.has(t) && !fileByDate.has(t))),
  ].sort((a, b) => a - b);
  const position = new Map(newDates.map((t, n) => [t, highest + n + 1]));
  return (r) => {
    if (Number.isFinite(r.workoutNum)) return r.workoutNum;
    const n = held.byDate.get(dayOf(r)) ?? fileByDate.get(dayOf(r)) ?? position.get(dayOf(r));
    if (n === undefined) throw new Error('continuedWorkoutNum: the row is not one of the new rows given');
    return n;
  };
}

/**
 * Reads each of `ids` again from the lift records left on it (decision 14): its dates; whether a
 * lift on it is outside its program (`unmatched`, as the import sets it); and unless the lifter
 * chose its status, the status the rules suggest as of `asOf`, judged against the macrocycle that
 * follows it, spans read as {@link placeOnStored} reads them. A commit runs it on the macrocycles
 * its stretches joined, once every program's rows and macrocycles are written; undo runs it on
 * the batch's macrocycles, once every part's rows are deleted, its emptied macrocycles removed and
 * its status choices released. So what follows is read from what stays, whichever program it's
 * under. Every macrocycle's dates are written before any status is read, so the order of `ids`
 * doesn't matter. A macrocycle that isn't `imported`, is gone, or has no rows left is skipped.
 * Returns how many it read again.
 */
export async function recomputeMacrocycles(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord'>,
  ids: readonly string[],
  programs: readonly KnownProgram[],
  asOf: Date,
): Promise<number> {
  if (ids.length === 0) return 0;
  const wanted = new Set(ids);
  const targets = (await repos.macrocycle.listAll()).filter((m) => wanted.has(m.id) && m.origin === 'imported');
  const recomputed: Array<{ m: MacrocycleRow; startDate: Date; endDate: Date; completed: number }> = [];
  for (const m of targets) {
    const records = await repos.liftRecord.getLiftRecords(m.program, m.macrocycleNum);
    if (records.length === 0) continue;
    const times = records.map((r) => toUTCMidnight(r.date).getTime());
    const startDate = new Date(Math.min(...times));
    const endDate = new Date(Math.max(...times));
    const lifts = programs.find((p) => p.id === m.program)?.lifts;
    const unmatched = lifts === undefined || records.some((r) => !lifts.has(liftKey(r.lift)));
    await repos.macrocycle.update(m.id, { startDate, endDate, unmatched });
    recomputed.push({ m, startDate, endDate, completed: new Set(records.map((r) => r.workoutNum)).size });
  }

  const unchosen = recomputed.filter(({ m }) => !m.statusChosen && programs.some((p) => p.id === m.program));
  if (unchosen.length === 0) return recomputed.length;
  const spans = await storedSpans(repos);
  for (const { m, startDate, endDate, completed } of unchosen) {
    const known = programs.find((p) => p.id === m.program);
    if (!known) continue;
    const after = spans
      .filter((o) => o.macrocycle.id !== m.id && o.start > endDate.getTime())
      .sort((a, b) => a.start - b.start)[0];
    const { status } = suggestStretchStatus(known, {
      completed,
      firstDate: startDate,
      lastDate: endDate,
      next: after ? { program: after.macrocycle.program } : undefined,
      importDate: asOf,
    });
    await repos.macrocycle.update(m.id, { status });
  }
  return recomputed.length;
}

/**
 * Undoes a batch's status choices (#1255). The choice in force on a macrocycle is the latest
 * surviving batch's. For each of `choices`:
 *
 * - If no later surviving batch chose a status for the macrocycle, this one's is in force: while
 *   the macrocycle still holds it, the status and its chosen flag go back to what the batch found.
 *   A status the lifter set since stays.
 * - Otherwise, if the next later batch found this one's choice, its choice was made over this one,
 *   so it takes this one's `before` as its own, and undoing it later puts back what was there
 *   before either. If it found something else, a status set between the two, this choice was no
 *   longer in force and is dropped.
 *
 * Either way undoing the batches' choices in any order ends where none had run, keeping any status
 * set outside them. `rows` holds the macrocycles as they are now, by id.
 */
export async function releaseStatusChoices(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'importBatch'>,
  batch: Pick<ImportBatchRecord, 'id' | 'createdAt'>,
  choices: readonly StatusChoice[],
  rows: ReadonlyMap<string, MacrocycleRow>,
): Promise<void> {
  const isLater = (b: Pick<ImportBatchRecord, 'id' | 'createdAt'>) =>
    b.createdAt.getTime() > batch.createdAt.getTime() || (b.createdAt.getTime() === batch.createdAt.getTime() && b.id > batch.id);
  for (const choice of choices) {
    const current = rows.get(choice.id);
    if (!current) continue;
    const next = (await repos.importBatch.listChoosing(choice.id))
      .filter(isLater)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (next?.macrocycles) {
      const found = next.macrocycles.chosen.find((c) => c.id === choice.id)?.before;
      if (found?.statusChosen && found.status === choice.chose) {
        const chosen = next.macrocycles.chosen.map((c) => (c.id === choice.id ? { ...c, before: choice.before } : c));
        await repos.importBatch.updateMacrocycles(next.id, { ...next.macrocycles, chosen });
      }
    } else if (current.statusChosen && current.status === choice.chose) {
      await repos.macrocycle.update(choice.id, {
        statusChosen: choice.before.statusChosen,
        ...(choice.before.status ? { status: choice.before.status } : {}),
      });
    }
  }
}
