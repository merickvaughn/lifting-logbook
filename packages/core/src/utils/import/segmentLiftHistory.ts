import { BUILT_IN_KNOWN_PROGRAMS } from '../../presets';
import {
  KnownProgram,
  liftKey,
  matchProgramForKeys,
  programNameKey,
  programNamedBy,
  programsContaining,
  ProgramMatch,
  SetOrder,
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
  /** Orders a lift's sets in a session; row order when missing. */
  setNum?: number | null;
  /** The set's weight; a lift's weights give its session's set order. */
  weight?: number | null;
  /** Which occurrence of the lift in its workout, from 0. Only the first gives a set order. */
  occurrence?: number | null;
}

export interface SegmentLiftHistoryOptions {
  /**
   * The day of the import, as the lifter's local calendar day at UTC midnight (the form
   * sessions are bucketed in). A last stretch's status is judged against it. Passing
   * `new Date()` in a US evening would give tomorrow's UTC day and move every edge a day.
   */
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

/** A lift whose sets ran in another order than the stretch so far had settled on. */
export interface SetOrderChange {
  lift: string;
  from: SetOrder;
  to: SetOrder;
}

/** Why a stretch starts where it does. */
export type StretchStartReason =
  | { kind: 'first-session' }
  | { kind: 'gap'; days: number }
  | { kind: 'previous-run-finished' }
  /** `from` is `null` when the stretch so far had no `Program` value. */
  | { kind: 'program-column-changed'; from: string | null; to: string }
  | { kind: 'lift-outside-program'; lifts: string[] }
  | { kind: 'set-order-changed'; lifts: SetOrderChange[] }
  /** The stretch before had lifts no one program contains (a transition day), and this session fits one. */
  | { kind: 'previous-fits-no-program' }
  | { kind: 'workout-number-fell-back'; from: number; to: number }
  | { kind: 'file-macrocycle'; macrocycleNum: number };

/** Where a stretch's program came from (decision 9). */
export type StretchProgramReason =
  | { kind: 'column'; value: string }
  /** `bySetOrder`: sessions' set order chose among programs that all contain the lifts. */
  | { kind: 'lifts'; tiedWith: string[]; bySetOrder: boolean }
  | { kind: 'source' };

/** Why a stretch has its status, or none. */
export type StretchStatusReason =
  | { kind: 'all-workouts-done' }
  | { kind: 'next-is-restart' }
  | { kind: 'next-is-different-program' }
  /** A stretch starts after this one, but its program is unknown until the lifter confirms it. */
  | { kind: 'next-is-unmatched' }
  | { kind: 'last-session-stale'; daysBeforeImport: number }
  | { kind: 'past-expected-length'; weeksSinceStart: number }
  | { kind: 'inside-expected-length'; weeksSinceStart: number }
  | { kind: 'unmatched' };

export interface HistoryStretch<T> {
  /**
   * The suggested program: the known one the file's `Program` column names, else the one its
   * lifts match, else the Source program. A stretch whose column names no known program
   * ("GZCLP") is stored under the Source program, unmatched, for the lifter to map.
   */
  program: string;
  /**
   * Whether every lift belongs to `program`, so its length is known. An unmatched stretch
   * has no suggested status, and the lifter confirms its program and status at Assign. A
   * stretch whose column names a program some of its lifts aren't in stays under the
   * column's program, unmatched.
   */
  matched: boolean;
  /**
   * The lifts that keep the stretch from matching, as first spelled in the file: those
   * outside `candidateProgram` when there is one, else outside `program`. Empty when matched,
   * and empty for a stretch unmatched only because its column names no known program.
   */
  liftsOutsideProgram: string[];
  /**
   * For an unmatched stretch, the known program it is if the lifter confirms it: the one its
   * lifts match when its column names no known program or a lift in no known program (an
   * accessory) is all that's outside, or the column's program when only accessories are
   * outside that.
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
  /**
   * In a file with macrocycle numbers, dated rows with a blank number and no earlier row in
   * the same program to take one from: the lifter files them.
   */
  unnumbered: T[];
  conflicts: FileNumberConflict[];
}

function maxOf(values: readonly number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  return max;
}

function minOf(values: readonly number[]): number {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return min;
}

/**
 * The order a lift's sets ran in, by where the heaviest is. The file has no warm-up flag, so
 * sets climbing to the top may be warm-ups:
 * - all equal, or 2 or more closing sets at the top weight (warm-ups, then straight sets): `straight`;
 * - the first set: `descending`;
 * - only the last set: `ascending`;
 * - in the middle: `descending` when every set after the top is lighter than the one before
 *   (warm-ups, then a reverse pyramid), and `ascending` when they level off (5/3/1's climb,
 *   then back-off sets such as Boring But Big or First Set Last).
 *
 * Fewer than 2 weights give no order.
 */
export function classifySetOrder(weights: readonly number[]): SetOrder | null {
  if (weights.length < 2) return null;
  const top = maxOf(weights);
  if (weights.every((w) => w === top)) return 'straight';
  if (weights[0] === top) return 'descending';
  let closingAtTop = 0;
  for (let i = weights.length - 1; i >= 0 && weights[i] === top; i--) closingAtTop++;
  if (closingAtTop >= 2) return 'straight';
  if (closingAtTop === 1) return 'ascending';
  for (let i = weights.lastIndexOf(top) + 1; i < weights.length; i++) {
    if ((weights[i] ?? 0) >= (weights[i - 1] ?? 0)) return 'ascending';
  }
  return 'descending';
}

interface Session<T> {
  date: Date;
  rows: T[];
  /** liftKey → the lift as first spelled. */
  lifts: Map<string, string>;
  /** The first `Program` cell with a letter or digit, trimmed. */
  programValue?: string;
  /** The file's `Workout #` cells; a session with none takes the session above's (see `fillWorkoutNums`). */
  workoutNums: number[];
  /** liftKey → the order its sets ran in, for lifts with 2 or more weighed sets. */
  orders: Map<string, SetOrder>;
}

function isValidDate(date: Date | null | undefined): date is Date {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function sessionOrders(rows: readonly LiftHistoryRow[]): Map<string, SetOrder> {
  const sets = new Map<string, LiftHistoryRow[]>();
  for (const row of rows) {
    if ((row.occurrence ?? 0) !== 0 || !isFiniteNumber(row.weight)) continue;
    const key = liftKey(row.lift);
    let liftRows = sets.get(key);
    if (!liftRows) sets.set(key, (liftRows = []));
    liftRows.push(row);
  }
  const orders = new Map<string, SetOrder>();
  for (const [key, liftRows] of sets) {
    const numbered = liftRows.every((r) => isFiniteNumber(r.setNum));
    const ordered = numbered ? [...liftRows].sort((a, b) => (a.setNum ?? 0) - (b.setNum ?? 0)) : liftRows;
    const order = classifySetOrder(ordered.map((r) => r.weight ?? 0));
    if (order) orders.set(key, order);
  }
  return orders;
}

function toSessions<T extends LiftHistoryRow>(rows: readonly T[]): Session<T>[] {
  const byDay = new Map<number, Session<T>>();
  for (const row of rows) {
    if (!isValidDate(row.date)) continue;
    const date = toUTCMidnight(row.date);
    let session = byDay.get(date.getTime());
    if (!session) {
      session = { date, rows: [], lifts: new Map(), workoutNums: [], orders: new Map() };
      byDay.set(date.getTime(), session);
    }
    session.rows.push(row);
    const key = liftKey(row.lift);
    if (!session.lifts.has(key)) session.lifts.set(key, row.lift.trim());
    if (session.programValue === undefined) {
      const program = programCell(row.program);
      if (program !== undefined) session.programValue = program;
    }
    if (isFiniteNumber(row.workoutNum)) session.workoutNums.push(row.workoutNum);
  }
  const sessions = [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const session of sessions) session.orders = sessionOrders(session.rows);
  return sessions;
}

/** A `Program` cell trimmed, or `undefined` when it has no letter or digit ("", "-", "—"), which counts as blank. */
function programCell(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && programNameKey(trimmed) ? trimmed : undefined;
}

/**
 * Decision 6 for a file that numbers workouts: a session with no `Workout #` takes the
 * number of the session above it, and sessions before the first number count up to it
 * (two blank sessions before workout 3 are 1 and 2), never below 1.
 */
function fillWorkoutNums<T>(sessions: readonly Session<T>[]): void {
  const firstIndex = sessions.findIndex((s) => s.workoutNums.length > 0);
  const first = sessions[firstIndex];
  if (!first) return;
  const firstNum = minOf(first.workoutNums);
  sessions.forEach((session, i) => {
    if (session.workoutNums.length > 0) return;
    if (i < firstIndex) {
      session.workoutNums = [Math.max(1, firstNum - (firstIndex - i))];
      return;
    }
    const above = sessions[i - 1];
    session.workoutNums = above ? [maxOf(above.workoutNums)] : [];
  });
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

/** The most frequent order in a tally; a tie goes to the first seen. */
function settledOrder(tally: ReadonlyMap<SetOrder, number> | undefined): SetOrder | undefined {
  let best: SetOrder | undefined;
  let bestCount = 0;
  for (const [order, count] of tally ?? []) {
    if (count > bestCount) {
      best = order;
      bestCount = count;
    }
  }
  return best;
}

/** A stretch being built, with running totals so adding a session costs the same however long it is. */
interface Draft<T> {
  sessions: Session<T>[];
  start: StretchStartReason;
  fileMacrocycleNum?: number;
  /** In file mode, the program key the file's group was keyed on, so overlaps compare like with like. */
  groupKey?: string;
  /** The first `Program` value, its comparison key, and the known program it names. */
  column?: ProgramCell;
  /** liftKey → the lift as first spelled. */
  allLifts: Map<string, string>;
  /** The lifts some known program contains. */
  knownLifts: Set<string>;
  workoutNums: Set<number>;
  /** Program id → sessions whose set order agrees with it. */
  agreement: Map<string, number>;
  /** liftKey → how often each set order was seen. */
  orders: Map<string, Map<SetOrder, number>>;
  /** Decision 9's match for the known lifts, set order first; `null` when no program contains them. */
  match: ProgramMatch | null;
  /**
   * The program the draft is following: the known one its column names, else `match`'s. A
   * column naming no known program means none, so no length or lift rule applies.
   */
  followed?: KnownProgram;
  /** Sessions in a row `followed` has been the same program. */
  followedFor: number;
}

interface ProgramCell {
  value: string;
  /** One key for every spelling: the known program's id, else `name:` and its letters and digits. */
  key: string;
  program?: KnownProgram;
}

/** Ties between custom programs go by name (owner decision 3), in one collation on every host. */
const NAME_ORDER = new Intl.Collator('en');

class Segmenter<T extends LiftHistoryRow> {
  private readonly programs: readonly KnownProgram[];
  /** Every lift some known program contains. A lift outside them all never splits a run. */
  private readonly liftsInAnyProgram: ReadonlySet<string>;
  private readonly cells = new Map<string, ProgramCell>();

  constructor(
    private readonly options: SegmentLiftHistoryOptions,
    /** Whether any row has a `Workout #`; completed workouts then count distinct numbers. */
    private readonly fileNumbersWorkouts: boolean,
  ) {
    const custom = [...(options.customPrograms ?? [])].sort(
      (a, b) => NAME_ORDER.compare(a.name ?? a.id, b.name ?? b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    this.programs = [...BUILT_IN_KNOWN_PROGRAMS, ...custom];
    this.liftsInAnyProgram = new Set(this.programs.flatMap((p) => [...p.lifts]));
  }

  /** A non-blank `Program` value's key and known program, worked out once per distinct value. */
  cell(value: string): ProgramCell {
    let cell = this.cells.get(value);
    if (!cell) {
      const program = programNamedBy(value, this.programs);
      cell = { value, key: program?.id ?? `name:${programNameKey(value)}`, ...(program ? { program } : {}) };
      this.cells.set(value, cell);
    }
    return cell;
  }

  private newDraft(start: StretchStartReason, fileMacrocycleNum?: number, groupKey?: string): Draft<T> {
    return {
      sessions: [],
      start,
      ...(fileMacrocycleNum !== undefined ? { fileMacrocycleNum } : {}),
      ...(groupKey !== undefined ? { groupKey } : {}),
      allLifts: new Map(),
      knownLifts: new Set(),
      workoutNums: new Set(),
      agreement: new Map(),
      orders: new Map(),
      match: null,
      followedFor: 0,
    };
  }

  /** Whether a session's set order agrees with a program: some lift it has an order for, and none that differs. */
  private agrees(program: KnownProgram, session: Session<T>): boolean {
    let any = false;
    for (const [key, order] of session.orders) {
      const expected = program.setOrder.get(key);
      if (expected === undefined) continue;
      if (expected !== order) return false;
      any = true;
    }
    return any;
  }

  private add(draft: Draft<T>, session: Session<T>): void {
    draft.sessions.push(session);
    if (!draft.column && session.programValue !== undefined) draft.column = this.cell(session.programValue);
    for (const [key, name] of session.lifts) {
      if (!draft.allLifts.has(key)) draft.allLifts.set(key, name);
      if (this.liftsInAnyProgram.has(key)) draft.knownLifts.add(key);
    }
    for (const num of session.workoutNums) draft.workoutNums.add(num);
    for (const [key, order] of session.orders) {
      const tally = draft.orders.get(key) ?? new Map<SetOrder, number>();
      tally.set(order, (tally.get(order) ?? 0) + 1);
      draft.orders.set(key, tally);
    }
    for (const program of this.programs) {
      if (this.agrees(program, session)) {
        draft.agreement.set(program.id, (draft.agreement.get(program.id) ?? 0) + 1);
      }
    }
    draft.match = matchProgramForKeys(draft.knownLifts, this.programs, this.options.sourceProgram, draft.agreement);
    const followed = draft.column ? draft.column.program : draft.match?.program;
    draft.followedFor = !followed ? 0 : followed === draft.followed ? draft.followedFor + 1 : 1;
    if (followed) draft.followed = followed;
    else delete draft.followed;
  }

  private completedWorkouts(draft: Draft<T>): number {
    return this.fileNumbersWorkouts ? draft.workoutNums.size : draft.sessions.length;
  }

  /**
   * Whether the program the draft follows has held for a week of its sessions
   * (`workoutCount / lengthWeeks`, rounded up). Before then a run's first sessions may fit
   * a smaller program than the one it is. A followed program always has lifts, so both
   * counts are at least 1.
   */
  private settled(draft: Draft<T>): boolean {
    const program = draft.followed;
    return program !== undefined && draft.followedFor >= Math.ceil(program.workoutCount / program.lengthWeeks);
  }

  private knownLiftsOf(session: Session<T>): Set<string> {
    return new Set([...session.lifts.keys()].filter((key) => this.liftsInAnyProgram.has(key)));
  }

  /** Why `sessions[i]` can't continue `draft`, or `null` when it does (decisions 4, 6, 7 and 9). */
  private boundary(draft: Draft<T>, sessions: readonly Session<T>[], i: number): StretchStartReason | null {
    const next = sessions[i];
    const last = draft.sessions[draft.sessions.length - 1];
    if (!next || !last) return null;
    const days = daysBetween(last.date, next.date);
    if (days > BREAK_DAYS) return { kind: 'gap', days };

    const program = draft.followed;
    if (program && this.completedWorkouts(draft) >= program.workoutCount) {
      return { kind: 'previous-run-finished' };
    }

    if (next.programValue !== undefined) {
      const nextCell = this.cell(next.programValue);
      if (draft.column) {
        if (draft.column.key !== nextCell.key) {
          return { kind: 'program-column-changed', from: draft.column.value, to: next.programValue };
        }
      } else {
        // A value appearing mid-stretch splits only when it names a program the stretch's
        // lifts can't belong to; otherwise the lifts decide, as with no column.
        const named = nextCell.program;
        if (named && [...draft.knownLifts].some((key) => !named.lifts.has(key))) {
          return { kind: 'program-column-changed', from: null, to: next.programValue };
        }
      }
    }

    // A stretch with a `Program` value is the program it names: a blank cell after it
    // continues it, so lifts and set order can't split it.
    if (!draft.column) {
      // A stretch whose lifts no one program contains (a transition day) can't follow any
      // program, so the first session after it that fits one starts a new stretch.
      if (draft.knownLifts.size > 0 && !draft.match) {
        const nextKnown = this.knownLiftsOf(next);
        if (nextKnown.size > 0 && programsContaining(nextKnown, this.programs).length > 0) {
          return { kind: 'previous-fits-no-program' };
        }
      }
      const outside = this.liftsOutside(draft, next);
      if (outside) return outside;
      const order = this.setOrderChange(draft, sessions, i);
      if (order) return order;
    }

    if (this.fileNumbersWorkouts && last.workoutNums.length > 0 && next.workoutNums.length > 0) {
      const from = maxOf(last.workoutNums);
      const to = minOf(next.workoutNums);
      if (to < from) return { kind: 'workout-number-fell-back', from, to };
    }
    return null;
  }

  /**
   * A lift in `next` that the stretch's program can't have. Until the program the stretch
   * follows has settled, it may fit several (Leangains and RPT share most lifts), so only a
   * lift no fitting program has splits. Once settled, a lift outside that program splits,
   * which catches a switch to a larger program (5/3/1 to RPT). A move to a subset program
   * can't show here (decision 9).
   */
  private liftsOutside(draft: Draft<T>, next: Session<T>): StretchStartReason | null {
    const nextKnown = [...this.knownLiftsOf(next)];
    if (draft.knownLifts.size === 0 || nextKnown.length === 0) return null;
    let outside: string[];
    if (this.settled(draft) && draft.followed) {
      const followed = draft.followed;
      outside = nextKnown.filter((key) => !followed.lifts.has(key));
    } else {
      const fitting = programsContaining(draft.knownLifts, this.programs);
      if (fitting.length === 0) return null;
      outside = nextKnown.filter((key) => !fitting.some((p) => p.lifts.has(key)));
    }
    return outside.length > 0
      ? { kind: 'lift-outside-program', lifts: outside.map((key) => next.lifts.get(key) ?? key) }
      : null;
  }

  /** How a session's set order compares with the draft's settled one, lift by lift. */
  private compareOrder(draft: Draft<T>, session: Session<T>): 'no-signal' | 'agrees' | SetOrderChange[] {
    const changes: SetOrderChange[] = [];
    let compared = 0;
    for (const [key, order] of session.orders) {
      const settled = settledOrder(draft.orders.get(key));
      if (settled === undefined) continue;
      compared++;
      if (order === settled) return 'agrees';
      changes.push({ lift: session.lifts.get(key) ?? key, from: settled, to: order });
    }
    return compared === 0 ? 'no-signal' : changes;
  }

  /**
   * A switch shown by set order (RPT's sets fall from the top set; 5/3/1's climb to it).
   * After the stretch has settled, a session whose every lift with an order runs against
   * the stretch's splits, if the next session that shows an order, before any break, does
   * too. One odd session doesn't split a run.
   */
  private setOrderChange(draft: Draft<T>, sessions: readonly Session<T>[], i: number): StretchStartReason | null {
    if (!this.settled(draft)) return null;
    const next = sessions[i];
    if (!next) return null;
    const change = this.compareOrder(draft, next);
    if (!Array.isArray(change)) return null;
    for (let j = i + 1; j < sessions.length; j++) {
      const later = sessions[j];
      const before = sessions[j - 1];
      if (!later || !before || daysBetween(before.date, later.date) > BREAK_DAYS) return null;
      const seen = this.compareOrder(draft, later);
      if (seen === 'no-signal') continue;
      return seen === 'agrees' ? null : { kind: 'set-order-changed', lifts: change };
    }
    return null;
  }

  byDates(sessions: readonly Session<T>[]): Draft<T>[] {
    if (this.fileNumbersWorkouts) fillWorkoutNums(sessions);
    const drafts: Draft<T>[] = [];
    sessions.forEach((session, i) => {
      const current = drafts[drafts.length - 1];
      const reason = current ? this.boundary(current, sessions, i) : { kind: 'first-session' as const };
      if (current && !reason) {
        this.add(current, session);
        return;
      }
      const draft = this.newDraft(reason ?? { kind: 'first-session' });
      this.add(draft, session);
      drafts.push(draft);
    });
    return drafts;
  }

  /**
   * Decision 8: one stretch per file program and number, whatever the dates say. A blank
   * number takes the number of the nearest row above it in the same program (the row above
   * when its `Program` cell is blank too), and a row with none to take is `unnumbered`. A
   * blank `Program` cell belongs with the rest of its number.
   */
  byFileNumbers(rows: readonly T[]): { drafts: Draft<T>[]; unnumbered: T[] } {
    const cellKey = (row: T) => {
      const value = programCell(row.program);
      return value === undefined ? undefined : this.cell(value).key;
    };
    const numbered: { row: T; num: number; key: string | undefined }[] = [];
    const unnumbered: T[] = [];
    const lastByProgram = new Map<string, number>();
    let lastAny: number | undefined;
    for (const row of rows) {
      const key = cellKey(row);
      const num = isFiniteNumber(row.macrocycleNum)
        ? row.macrocycleNum
        : key === undefined
          ? lastAny
          : lastByProgram.get(key);
      if (num === undefined) {
        unnumbered.push(row);
        continue;
      }
      lastAny = num;
      if (key !== undefined) lastByProgram.set(key, num);
      numbered.push({ row, num, key });
    }

    const firstKey = new Map<number, string>();
    for (const { num, key } of numbered) if (key !== undefined && !firstKey.has(num)) firstKey.set(num, key);
    const lastKey = new Map<number, string>();
    const groups = new Map<string, { num: number; key: string; rows: T[] }>();
    for (const { row, num, key } of numbered) {
      if (key !== undefined) lastKey.set(num, key);
      const programKey = key ?? lastKey.get(num) ?? firstKey.get(num) ?? '';
      const id = `${programKey}\u0000${num}`;
      const group = groups.get(id) ?? { num, key: programKey, rows: [] };
      group.rows.push(row);
      groups.set(id, group);
    }

    const drafts = [...groups.values()]
      .map((group) => {
        const sessions = toSessions(group.rows);
        if (this.fileNumbersWorkouts) fillWorkoutNums(sessions);
        const draft = this.newDraft({ kind: 'file-macrocycle', macrocycleNum: group.num }, group.num, group.key);
        for (const session of sessions) this.add(draft, session);
        return draft;
      })
      .sort((a, b) => (a.sessions[0]?.date.getTime() ?? 0) - (b.sessions[0]?.date.getTime() ?? 0));
    return { drafts, unnumbered };
  }

  /** Decision 9's program for a whole stretch, from the same totals `boundary` follows. */
  private resolveProgram(draft: Draft<T>): {
    program: KnownProgram | undefined;
    id: string;
    reason: StretchProgramReason;
    outside: string[];
    candidate?: string;
  } {
    const outsideOf = (program: KnownProgram) =>
      [...draft.allLifts].filter(([key]) => !program.lifts.has(key)).map(([, name]) => name);
    const onlyUnknownOutside = (program: KnownProgram) =>
      [...draft.allLifts.keys()].every((key) => program.lifts.has(key) || !this.liftsInAnyProgram.has(key));

    const column = draft.column;
    if (column?.program) {
      // The column's program stands even when lifts disagree with it; the stretch is then
      // unmatched for the lifter to confirm.
      const named = column.program;
      const outside = outsideOf(named);
      return {
        program: named,
        id: named.id,
        reason: { kind: 'column', value: column.value },
        outside,
        ...(outside.length > 0 && onlyUnknownOutside(named) ? { candidate: named.id } : {}),
      };
    }
    const match = draft.match;
    if (!column && match && draft.knownLifts.size === draft.allLifts.size) {
      return {
        program: match.program,
        id: match.program.id,
        reason: { kind: 'lifts', tiedWith: match.tiedWith, bySetOrder: match.bySetOrder },
        outside: [],
      };
    }
    // Unmatched: stored under the Source program (decision 9). A lift in no known program
    // doesn't split the run, and a column naming no known program ("GZCLP") is the lifter's
    // own label; either way the lifter confirms the program its lifts match.
    const source = this.programs.find((p) => p.id === this.options.sourceProgram);
    const reference = match?.program ?? source;
    return {
      program: undefined,
      id: this.options.sourceProgram,
      reason: column ? { kind: 'column', value: column.value } : { kind: 'source' },
      outside: reference ? outsideOf(reference) : [...draft.allLifts.values()],
      ...(match ? { candidate: match.program.id } : {}),
    };
  }

  build(drafts: readonly Draft<T>[]): HistoryStretch<T>[] {
    const resolved = drafts.map((draft) => {
      const r = this.resolveProgram(draft);
      const matchedProgram = r.outside.length === 0 ? r.program : undefined;
      const first = draft.sessions[0];
      const last = draft.sessions[draft.sessions.length - 1];
      if (!first || !last) throw new Error('A stretch has at least one session.');
      return { draft, ...r, matchedProgram, first, last };
    });
    const starts = resolved.map((r) => r.first.date.getTime());
    return resolved.map(({ draft, id, reason, outside, candidate, matchedProgram, first, last }) => {
      const matched = matchedProgram !== undefined;
      const completed = this.completedWorkouts(draft);
      // The stretch that follows is the first to start after this one ends; in file mode a
      // number can run alongside another (decision 8), and that one doesn't follow it.
      const following = resolved[firstAfter(starts, last.date.getTime())];
      const next = following
        ? { program: following.matchedProgram?.id ?? following.candidate }
        : undefined;
      const { status, statusReason } = matchedProgram
        ? this.status(matchedProgram, completed, last.date, first.date, next)
        : { status: null, statusReason: { kind: 'unmatched' } as const };
      return {
        program: id,
        matched,
        liftsOutsideProgram: matched ? [] : outside,
        ...(candidate !== undefined && !matched ? { candidateProgram: candidate } : {}),
        ...(draft.fileMacrocycleNum !== undefined ? { fileMacrocycleNum: draft.fileMacrocycleNum } : {}),
        startDate: first.date,
        endDate: last.date,
        sessions: draft.sessions.map((s, n) => ({
          date: s.date,
          rows: s.rows,
          workoutNum: this.fileNumbersWorkouts && s.workoutNums.length > 0 ? minOf(s.workoutNums) : n + 1,
        })),
        completedWorkouts: completed,
        expectedWorkouts: matchedProgram ? matchedProgram.workoutCount : null,
        status,
        reasons: { start: draft.start, program: reason, status: statusReason },
      };
    });
  }

  /**
   * Decisions 6 and 7. `next` is the stretch that starts after this one ends, with its
   * matched or candidate program, or `undefined` when none does. A stretch with workouts
   * left and one after it is `abandoned`, which wins over `overran`.
   */
  private status(
    program: KnownProgram,
    completed: number,
    lastDate: Date,
    firstDate: Date,
    next: { program: string | undefined } | undefined,
  ): { status: StretchStatus; statusReason: StretchStatusReason } {
    if (completed >= program.workoutCount) {
      return { status: 'completed', statusReason: { kind: 'all-workouts-done' } };
    }
    if (next) {
      const kind =
        next.program === undefined
          ? 'next-is-unmatched'
          : next.program === program.id
            ? 'next-is-restart'
            : 'next-is-different-program';
      return { status: 'abandoned', statusReason: { kind } };
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

  /**
   * Decision 8's conflicts: a break over 14 days inside one number, measured without the
   * sessions decision 5 would call lone, and numbers of one file program whose dates
   * interleave. Each stretch that overlaps an earlier one is reported once, against the
   * earlier stretch reaching furthest.
   */
  fileNumberConflicts(drafts: readonly Draft<T>[], stretches: readonly HistoryStretch<T>[]): FileNumberConflict[] {
    const conflicts: FileNumberConflict[] = [];
    drafts.forEach((draft, i) => {
      const kept = draft.sessions.filter((_, n) => !isLone(draft.sessions, n));
      for (let n = 1; n < kept.length; n++) {
        const from = kept[n - 1]?.date;
        const to = kept[n]?.date;
        if (!from || !to) continue;
        const days = daysBetween(from, to);
        if (days > BREAK_DAYS) conflicts.push({ kind: 'gap-inside-number', stretch: i, from, to, days });
      }
    });
    const byGroup = new Map<string, number[]>();
    drafts.forEach((draft, i) => {
      const key = draft.groupKey ?? '';
      let indexes = byGroup.get(key);
      if (!indexes) byGroup.set(key, (indexes = []));
      indexes.push(i);
    });
    for (const indexes of byGroup.values()) {
      // `stretches` is in start order, so each group's indexes are too.
      let reach = -Infinity;
      let reachIndex = -1;
      for (const i of indexes) {
        const stretch = stretches[i];
        if (!stretch) continue;
        if (reachIndex >= 0 && stretch.startDate.getTime() <= reach) {
          conflicts.push({ kind: 'numbers-overlap', stretches: [reachIndex, i] });
        }
        if (stretch.endDate.getTime() > reach) {
          reach = stretch.endDate.getTime();
          reachIndex = i;
        }
      }
    }
    return conflicts;
  }
}

/** The index of the first of `sorted` greater than `value`, or `sorted.length`. */
function firstAfter(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? Infinity) > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Groups imported lift history into suggested macrocycles from its dates.
 *
 * - A gap of more than {@link BREAK_DAYS} days between sessions, a finished run, a change in
 *   the file's `Program` column, a lift the stretch's program can't have, a transition day
 *   ending, a settled set order turning around, or a file workout number falling back
 *   starts a new stretch.
 * - A file with macrocycle numbers keeps its own groupings instead (decision 8): blank
 *   numbers take the one above, rows with none to take are `unnumbered`, and `conflicts`
 *   reports where the numbers disagree with the dates.
 * - Single-lift sessions inside a break are returned in `lone`, outside every stretch.
 * - Rows with no date are returned in `unplaced`.
 */
export function segmentLiftHistory<T extends LiftHistoryRow>(
  rows: readonly T[],
  options: SegmentLiftHistoryOptions,
): SegmentedLiftHistory<T> {
  const unplaced = rows.filter((row) => !isValidDate(row.date));
  const dated = rows.filter((row) => isValidDate(row.date));
  const segmenter = new Segmenter<T>(options, dated.some((row) => isFiniteNumber(row.workoutNum)));

  if (dated.some((row) => isFiniteNumber(row.macrocycleNum))) {
    // The file has already placed its sessions, so none is flagged as lone (decision 8).
    const { drafts, unnumbered } = segmenter.byFileNumbers(dated);
    const stretches = segmenter.build(drafts);
    return { stretches, lone: [], unplaced, unnumbered, conflicts: segmenter.fileNumberConflicts(drafts, stretches) };
  }

  const sessions = toSessions(dated);
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

  return { stretches: segmenter.build(segmenter.byDates(kept)), lone, unplaced, unnumbered: [], conflicts: [] };
}
