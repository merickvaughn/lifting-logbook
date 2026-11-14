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
import { isNonCycleProgram } from './nonCycle';

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

/**
 * The fields segmentation reads. A column the file doesn't map must be `null` or missing on
 * every row, never a default: one finite `macrocycleNum` turns the whole file over to its
 * own macrocycle numbers (decision 8), so no dates, gaps or lone sessions are read, and a
 * finite `workoutNum` is taken as the file's own workout number. `LiftRecord`'s required
 * numbers can't say "not mapped", so map rows to this shape rather than passing records.
 */
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
  /**
   * The lifter's custom programs, matched after the built-ins, in name order. Give each the
   * lifter's `name` for it (`{ ...knownProgramFromSpec(id, spec), name }`), so a `Program`
   * cell can name it and ties go by name rather than id. A custom program is open-ended
   * here: its spec may be one repeating block, so a run of it never finishes by length.
   */
  customPrograms?: readonly KnownProgram[];
}

export type StretchStatus = 'in-progress' | 'completed' | 'overran' | 'abandoned';

export interface HistorySession<T> {
  /** UTC midnight of the session's day. */
  date: Date;
  rows: T[];
  /**
   * When the stretch has a `Workout #`, the file's lowest number on this day; a session with
   * none takes the number of the session above it in the stretch, and sessions before the
   * stretch's first number count up to it (never below 1). Otherwise its place in the
   * stretch from 1.
   */
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
  /** A custom program has no expected length, so its last run is in progress until it goes stale. */
  | { kind: 'open-ended' }
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
  /**
   * With `fileMacrocycleNum`, the program group the file's rows were put in: its `Program`
   * key, or `''` when its cells are blank. {@link fileMacrocycleKey} of the two names the
   * stretch's rows (#1256).
   */
  fileGroup?: string;
  startDate: Date;
  endDate: Date;
  sessions: HistorySession<T>[];
  /** Distinct `workoutNum`s when the stretch has a `Workout #`, else sessions (decision 6). */
  completedWorkouts: number;
  /** Workouts in one run of `program`, or `null` when unmatched or a custom program (open-ended). */
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
   * Rows whose `Program` cell is `non-cycle` (decision 23): stored as non-cycle workouts, so
   * they're no session, take no part in any stretch, gap or lone session, and are returned
   * here whether dated or not.
   */
  nonCycle: T[];
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
  /** The file's `Workout #` cells on this day; empty when they're blank. */
  workoutNums: number[];
  /** liftKey → the order its sets ran in, for lifts with 2 or more weighed sets. */
  orders: Map<string, SetOrder>;
}

function isValidDate(date: Date | null | undefined): date is Date {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

/** A row with a valid date: only these are placed. */
type Dated<T extends LiftHistoryRow> = T & { date: Date };

function isDated<T extends LiftHistoryRow>(row: T): row is Dated<T> {
  return isValidDate(row.date);
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

function toSessions<T extends LiftHistoryRow>(rows: readonly Dated<T>[]): Session<T>[] {
  const byDay = new Map<number, Session<T>>();
  for (const row of rows) {
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
 * Decision 6 for one stretch with a `Workout #`: each session's lowest number; a session with
 * none takes the number of the session above it, and sessions before the stretch's first
 * number count up to it (two blank sessions before workout 3 are 1 and 2), never below 1.
 * `undefined` when no session in the stretch has a number. Numbers never cross a stretch
 * boundary, so a restart whose first cell is blank counts up rather than borrowing the last
 * run's number.
 */
function stretchWorkoutNums<T>(sessions: readonly Session<T>[]): number[] | undefined {
  const firstIndex = sessions.findIndex((s) => s.workoutNums.length > 0);
  const first = sessions[firstIndex];
  if (!first) return undefined;
  const leading = leadingWorkoutNums(minOf(first.workoutNums), firstIndex);
  let above = 0;
  return sessions.map((session, i) => {
    if (session.workoutNums.length > 0) {
      above = maxOf(session.workoutNums);
      return minOf(session.workoutNums);
    }
    return leading[i] ?? above;
  });
}

/**
 * The numbers `blanks` sessions before a stretch's first `Workout #` take, in session order:
 * they count up to `first`, never below 1 (two blanks before workout 3 are 1 and 2). Both
 * the `workoutNum` the lifter sees and the completed count use this, so they can't disagree.
 */
function leadingWorkoutNums(first: number, blanks: number): number[] {
  return Array.from({ length: blanks }, (_, i) => Math.max(1, first - (blanks - i)));
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

/**
 * The group a file macrocycle's stretch reports as `fileGroup`, and an export's commit pairs its
 * rows by: the program key its rows were grouped on.
 */
function fileGroupOf(draft: Draft<unknown>): string {
  return draft.groupKey ?? '';
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
  /**
   * Every file `Workout #` seen so far (a session may have several), plus the numbers the
   * blank sessions before the first one count up to ({@link leadingWorkoutNums}). Empty until
   * a session has one.
   */
  workoutNums: Set<number>;
  /** The highest `Workout #` of the latest session that had one; `undefined` until one does. */
  lastWorkoutNum?: number;
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

const BUILT_IN_IDS: ReadonlySet<string> = new Set(BUILT_IN_KNOWN_PROGRAMS.map((p) => p.id));

/**
 * A custom program is open-ended (owner decision on #1202): its spec may be one repeating
 * block, so it never finishes by length and is never `completed` or `overran`. Known by id,
 * so a copy of a built-in still has the built-in's length.
 */
export function isOpenEnded(program: KnownProgram): boolean {
  return !BUILT_IN_IDS.has(program.id);
}

/**
 * A run's suggested status (decisions 6 and 7), from its program, the distinct workouts it
 * completed and its first and last session dates, judged against `importDate`. `next` is the
 * stretch that follows it, with its program key (its column's, else its matched or candidate
 * program), or `undefined` when none does. A run with workouts left and one after it is
 * `abandoned`, which wins over `overran`. A custom program is open-ended: never `completed` or
 * `overran`. Undo reads a stored macrocycle's status again with it (#1255, decision 14).
 */
export function suggestStretchStatus(
  program: KnownProgram,
  run: {
    completed: number;
    firstDate: Date;
    lastDate: Date;
    next: { program: string | undefined } | undefined;
    importDate: Date;
  },
): { status: StretchStatus; statusReason: StretchStatusReason } {
  const openEnded = isOpenEnded(program);
  if (!openEnded && run.completed >= program.workoutCount) {
    return { status: 'completed', statusReason: { kind: 'all-workouts-done' } };
  }
  if (run.next) {
    const kind =
      run.next.program === undefined
        ? 'next-is-unmatched'
        : run.next.program === program.id
          ? 'next-is-restart'
          : 'next-is-different-program';
    return { status: 'abandoned', statusReason: { kind } };
  }
  const importDate = toUTCMidnight(run.importDate);
  const daysBeforeImport = daysBetween(run.lastDate, importDate);
  if (daysBeforeImport > BREAK_DAYS) {
    return { status: 'abandoned', statusReason: { kind: 'last-session-stale', daysBeforeImport } };
  }
  if (openEnded) return { status: 'in-progress', statusReason: { kind: 'open-ended' } };
  const daysSinceStart = daysBetween(run.firstDate, importDate);
  const weeksSinceStart = Math.floor(daysSinceStart / 7);
  return daysSinceStart >= program.lengthWeeks * 7
    ? { status: 'overran', statusReason: { kind: 'past-expected-length', weeksSinceStart } }
    : { status: 'in-progress', statusReason: { kind: 'inside-expected-length', weeksSinceStart } };
}

/** Ties between custom programs go by name (owner decision 3), in one collation on every host. */
const NAME_ORDER = new Intl.Collator('en');

class Segmenter<T extends LiftHistoryRow> {
  private readonly programs: readonly KnownProgram[];
  /** Every lift some known program contains. A lift outside them all never splits a run. */
  private readonly liftsInAnyProgram: ReadonlySet<string>;
  private readonly cells = new Map<string, ProgramCell>();

  constructor(private readonly options: SegmentLiftHistoryOptions) {
    const custom = [...(options.customPrograms ?? [])].sort(
      (a, b) => NAME_ORDER.compare(a.name ?? a.id, b.name ?? b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    this.programs = [...BUILT_IN_KNOWN_PROGRAMS, ...custom];
    this.liftsInAnyProgram = new Set(this.programs.flatMap((p) => [...p.lifts]));
  }

  /**
   * A non-blank `Program` value's key and known program, worked out once per distinct value.
   * A custom program with no lifts yet counts as unknown: it has no length or lifts to follow.
   */
  cell(value: string): ProgramCell {
    let cell = this.cells.get(value);
    if (!cell) {
      const named = programNamedBy(value, this.programs);
      const program = named && named.lifts.size > 0 ? named : undefined;
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
    if (session.workoutNums.length > 0) {
      if (draft.lastWorkoutNum === undefined) {
        for (const num of leadingWorkoutNums(minOf(session.workoutNums), draft.sessions.length - 1)) {
          draft.workoutNums.add(num);
        }
      }
      for (const num of session.workoutNums) draft.workoutNums.add(num);
      draft.lastWorkoutNum = maxOf(session.workoutNums);
    }
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

  /** Decision 6: distinct workout numbers when the stretch has a `Workout #`, else sessions. */
  private completedWorkouts(draft: Draft<T>): number {
    return draft.lastWorkoutNum !== undefined ? draft.workoutNums.size : draft.sessions.length;
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

    // A custom program is open-ended (owner decision on #1202): its spec may be one
    // repeating block, so only a built-in run finishes by length.
    const program = draft.followed;
    if (program && !isOpenEnded(program) && this.completedWorkouts(draft) >= program.workoutCount) {
      return { kind: 'previous-run-finished' };
    }

    if (next.programValue !== undefined) {
      const nextCell = this.cell(next.programValue);
      if (draft.column) {
        if (draft.column.key !== nextCell.key) {
          return { kind: 'program-column-changed', from: draft.column.value, to: next.programValue };
        }
      } else {
        // A value appearing mid-stretch splits when it names a program the stretch's lifts
        // can't belong to, or names no known program while the stretch matches one (the
        // lifter labelling a switch to a program of their own). Otherwise the lifts decide.
        const named = nextCell.program;
        const splits = named ? [...draft.knownLifts].some((key) => !named.lifts.has(key)) : draft.match !== null;
        if (splits) return { kind: 'program-column-changed', from: null, to: next.programValue };
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

    // Only the file's own numbers are compared: a blank cell between them doesn't hide a
    // fallback, and a blank at a stretch's start never borrows the previous run's number.
    const from = draft.lastWorkoutNum;
    if (from !== undefined && next.workoutNums.length > 0) {
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
      if (outside.length === 0) {
        // Each new lift is in some program the stretch fits, but no one program has them
        // all: a transition session. It splits off here so the run before keeps its program,
        // and `previous-fits-no-program` ends it when a session fits one again.
        const added = nextKnown.filter((key) => !draft.knownLifts.has(key));
        if (added.length > 0 && !fitting.some((p) => added.every((key) => p.lifts.has(key)))) outside = added;
      }
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
   * when its `Program` cell is blank too), else of a row of its own session (the same day and
   * program, or any program when its cell is blank), and a row with none to take is
   * `unnumbered`. A blank `Program` cell belongs with the rest of its number.
   */
  byFileNumbers(rows: readonly Dated<T>[]): { drafts: Draft<T>[]; unnumbered: T[] } {
    const cellKey = (row: T) => {
      const value = programCell(row.program);
      return value === undefined ? undefined : this.cell(value).key;
    };
    // A session's first row may leave its number to a later row (#1256). Unnumbered, it would
    // share a day with its own stretch, so no place the lifter could file it would be valid.
    const sessionNum = new Map<string, number>();
    for (const row of rows) {
      if (!isFiniteNumber(row.macrocycleNum)) continue;
      const day = toUTCMidnight(row.date).getTime();
      for (const key of [`${day}|*`, `${day}|${cellKey(row) ?? '*'}`]) {
        if (!sessionNum.has(key)) sessionNum.set(key, row.macrocycleNum);
      }
    }
    /** `session` is the row's number and day, so rows of one session share it. */
    const numbered: { row: Dated<T>; num: number; key: string | undefined; session: string }[] = [];
    const unnumbered: T[] = [];
    const lastByProgram = new Map<string, number>();
    let lastAny: number | undefined;
    for (const row of rows) {
      const key = cellKey(row);
      const num = isFiniteNumber(row.macrocycleNum)
        ? row.macrocycleNum
        : ((key === undefined ? lastAny : lastByProgram.get(key)) ??
          sessionNum.get(`${toUTCMidnight(row.date).getTime()}|${key ?? '*'}`));
      if (num === undefined) {
        unnumbered.push(row);
        continue;
      }
      lastAny = num;
      if (key !== undefined) lastByProgram.set(key, num);
      numbered.push({ row, num, key, session: `${num}|${toUTCMidnight(row.date).getTime()}` });
    }

    // A blank `Program` cell belongs with the nearest labelled row above it in its own
    // session (same day and number); one above the session's first label takes that label.
    // Only a session with no label looks wider: the nearest labelled row above of its number,
    // else the number's first. So two programs sharing a number, whether on one day or on
    // alternate days, don't trade rows.
    const firstKey = new Map<number, string>();
    const firstInSession = new Map<string, string>();
    for (const { num, key, session } of numbered) {
      if (key === undefined) continue;
      if (!firstKey.has(num)) firstKey.set(num, key);
      if (!firstInSession.has(session)) firstInSession.set(session, key);
    }
    const lastKey = new Map<number, string>();
    const lastInSession = new Map<string, string>();
    const groups = new Map<string, { num: number; key: string; rows: Dated<T>[] }>();
    for (const { row, num, key, session } of numbered) {
      if (key !== undefined) {
        lastKey.set(num, key);
        lastInSession.set(session, key);
      }
      const programKey =
        key ??
        lastInSession.get(session) ??
        firstInSession.get(session) ??
        lastKey.get(num) ??
        firstKey.get(num) ??
        '';
      const id = `${num}|${programKey}`;
      const group = groups.get(id) ?? { num, key: programKey, rows: [] };
      group.rows.push(row);
      groups.set(id, group);
    }

    const drafts = [...groups.values()]
      .map((group) => {
        const sessions = toSessions(group.rows);
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

  /**
   * The stretches, and each one's program group: the file's own `Program` key in file mode,
   * else (date mode, or a file number with only blank `Program` cells) the program it
   * resolved to, so numbers of one program compare like with like whether labelled or not.
   */
  build(drafts: readonly Draft<T>[]): { stretches: HistoryStretch<T>[]; groups: string[] } {
    const resolved = drafts.map((draft) => {
      const r = this.resolveProgram(draft);
      const matchedProgram = r.outside.length === 0 ? r.program : undefined;
      const first = draft.sessions[0];
      const last = draft.sessions[draft.sessions.length - 1];
      if (!first || !last) throw new Error('A stretch has at least one session.');
      return { draft, ...r, matchedProgram, first, last };
    });
    const groups = resolved.map((r) => r.draft.groupKey || r.program?.id || r.candidate || '');
    const follower = followers(
      resolved.map((r) => ({ start: r.first.date.getTime(), end: r.last.date.getTime() })),
      groups,
    );
    const stretches = resolved.map(({ draft, id, reason, outside, candidate, matchedProgram, first, last }, i) => {
      const matched = matchedProgram !== undefined;
      const completed = this.completedWorkouts(draft);
      const following = resolved[follower[i] ?? -1];
      // The follower's own `Program` column says what it is before its lifts do.
      const next = following
        ? { program: following.draft.column?.key ?? following.matchedProgram?.id ?? following.candidate }
        : undefined;
      const { status, statusReason } = matchedProgram
        ? this.status(matchedProgram, completed, last.date, first.date, next)
        : { status: null, statusReason: { kind: 'unmatched' } as const };
      const nums = stretchWorkoutNums(draft.sessions);
      return {
        program: id,
        matched,
        liftsOutsideProgram: matched ? [] : outside,
        ...(candidate !== undefined && !matched ? { candidateProgram: candidate } : {}),
        ...(draft.fileMacrocycleNum !== undefined
          ? { fileMacrocycleNum: draft.fileMacrocycleNum, fileGroup: fileGroupOf(draft) }
          : {}),
        startDate: first.date,
        endDate: last.date,
        sessions: draft.sessions.map((s, n) => ({ date: s.date, rows: s.rows, workoutNum: nums?.[n] ?? n + 1 })),
        completedWorkouts: completed,
        expectedWorkouts: matchedProgram && !isOpenEnded(matchedProgram) ? matchedProgram.workoutCount : null,
        status,
        reasons: { start: draft.start, program: reason, status: statusReason },
      };
    });
    return { stretches, groups };
  }

  private status(
    program: KnownProgram,
    completed: number,
    lastDate: Date,
    firstDate: Date,
    next: { program: string | undefined } | undefined,
  ): { status: StretchStatus; statusReason: StretchStatusReason } {
    return suggestStretchStatus(program, { completed, firstDate, lastDate, next, importDate: this.options.importDate });
  }

  /**
   * Decision 8's conflicts: a break over 14 days inside one number, measured without the
   * sessions decision 5 would call lone, and numbers of one file program whose dates
   * interleave. Each stretch that overlaps an earlier one is reported once, against the
   * earlier stretch reaching furthest.
   */
  fileNumberConflicts(
    drafts: readonly Draft<T>[],
    stretches: readonly HistoryStretch<T>[],
    groups: readonly string[],
  ): FileNumberConflict[] {
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
    for (const indexes of indexesByGroup(groups).values()) {
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

/** Each group's stretch indexes, in the order given. */
function indexesByGroup(groups: readonly string[]): Map<string, number[]> {
  const byGroup = new Map<string, number[]>();
  groups.forEach((group, i) => {
    let indexes = byGroup.get(group);
    if (!indexes) byGroup.set(group, (indexes = []));
    indexes.push(i);
  });
  return byGroup;
}

/**
 * Two programs' stretches that overlap by this many days or fewer are a hand-off, not two
 * programs running alongside: a lifter switching mid-week often logs the old program's last
 * session on or after the new one's first (owner decision on #1202).
 */
const HAND_OFF_DAYS = 7;

/**
 * For each stretch (in start order), the index of the stretch that follows it, or
 * `undefined`: the earliest to start after it that also ends after it, in its own group
 * when it starts no more than {@link HAND_OFF_DAYS} before this one ends, or in a group not
 * running alongside it. In file mode a program's numbers can run alongside
 * another program's (decision 8), and that program's later numbers don't follow this one. A
 * group runs alongside a stretch when one of its stretches starts inside it more than
 * {@link HAND_OFF_DAYS} before it ends, or it starts inside one of the group's that much
 * before that one ends. A shorter overlap is a hand-off, so the program taken over from is
 * followed by the one that took over.
 */
function followers(spans: readonly { start: number; end: number }[], groups: readonly string[]): (number | undefined)[] {
  const byGroup = new Map<string, { starts: number[]; reachBy: number[] }>();
  for (const [group, indexes] of indexesByGroup(groups)) {
    // The latest end among the group's first k stretches, so each overlap check is one search.
    let reach = -Infinity;
    byGroup.set(group, {
      starts: indexes.map((i) => spans[i]?.start ?? 0),
      reachBy: indexes.map((i) => (reach = Math.max(reach, spans[i]?.end ?? -Infinity))),
    });
  }
  const handOff = HAND_OFF_DAYS * DAY_MS;
  const alongside = (group: string, start: number, end: number): boolean => {
    const g = byGroup.get(group);
    if (!g) return false;
    if ((g.starts[firstAfter(g.starts, start - 1)] ?? Infinity) < end - handOff) return true;
    const startedBefore = firstAfter(g.starts, start) - 1;
    return startedBefore >= 0 && (g.reachBy[startedBefore] ?? -Infinity) > start + handOff;
  };
  return spans.map(({ start, end }, i) => {
    const checked = new Map<string, boolean>();
    // Stepping forward in start order keeps this linear however many groups a file has.
    for (let j = i + 1; j < spans.length; j++) {
      const group = groups[j];
      if (group === undefined || (spans[j]?.end ?? -Infinity) <= end) continue;
      if (group === groups[i]) {
        // The same program overlapping by more than a hand-off is two numbers at once (a
        // `numbers-overlap` conflict), not a restart.
        if ((spans[j]?.start ?? Infinity) >= end - handOff) return j;
        continue;
      }
      let along = checked.get(group);
      if (along === undefined) checked.set(group, (along = alongside(group, start, end)));
      if (!along) return j;
    }
    return undefined;
  });
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
/**
 * A file's rows as {@link segmentLiftHistory} and {@link fileMacrocycleKeys} both read them:
 * the non-cycle rows, the undated rest, and the dated rest that's grouped.
 */
function splitRows<T extends LiftHistoryRow>(allRows: readonly T[]) {
  const nonCycle = allRows.filter((row) => isNonCycleProgram(row.program));
  const rows = allRows.filter((row) => !isNonCycleProgram(row.program));
  return { nonCycle, unplaced: rows.filter((row) => !isDated(row)), dated: rows.filter(isDated) };
}

export function segmentLiftHistory<T extends LiftHistoryRow>(
  allRows: readonly T[],
  options: SegmentLiftHistoryOptions,
): SegmentedLiftHistory<T> {
  const { nonCycle, unplaced, dated } = splitRows(allRows);
  const segmenter = new Segmenter<T>(options);

  if (dated.some((row) => isFiniteNumber(row.macrocycleNum))) {
    // The file has already placed its sessions, so none is flagged as lone (decision 8).
    const { drafts, unnumbered } = segmenter.byFileNumbers(dated);
    const { stretches, groups } = segmenter.build(drafts);
    const conflicts = segmenter.fileNumberConflicts(drafts, stretches, groups);
    return { stretches, lone: [], unplaced, nonCycle, unnumbered, conflicts };
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

  return {
    stretches: segmenter.build(segmenter.byDates(kept)).stretches,
    lone,
    unplaced,
    nonCycle,
    unnumbered: [],
    conflicts: [],
  };
}

/** Names one file macrocycle: a stretch's `fileGroup` and `fileMacrocycleNum`, or a row's. */
export function fileMacrocycleKey(group: string, macrocycleNum: number): string {
  return `${group}|${macrocycleNum}`;
}

/**
 * Each row's file macrocycle, as {@link segmentLiftHistory} groups a file with macrocycle numbers,
 * by position: undefined for a row in none (undated, non-cycle or unnumbered). An export's commit
 * pairs rows with the macrocycles its breakdown names by this, so the pairing and the grouping
 * the lifter saw read the file one way, blank or differently spelled `Program` cells included
 * (#1256).
 */
export function fileMacrocycleKeys<T extends LiftHistoryRow>(
  rows: readonly T[],
  options: SegmentLiftHistoryOptions,
): Array<string | undefined> {
  const { dated } = splitRows(rows);
  const keys = new Map<T, string>();
  for (const draft of new Segmenter<T>(options).byFileNumbers(dated).drafts) {
    if (draft.fileMacrocycleNum === undefined) continue;
    const key = fileMacrocycleKey(fileGroupOf(draft), draft.fileMacrocycleNum);
    for (const session of draft.sessions) for (const row of session.rows) keys.set(row, key);
  }
  return rows.map((row) => keys.get(row));
}
