import { liftSpellings } from '../../catalog/builtInLift';
import { formatDateYYYYMMDD, parseYYYYMMDD } from '../jsUtil';
import type { ClassifiedRow } from './classifyAndCount';

/** The fields that identify one logged set within a (userId, program) scope. */
export interface LiftRecordKey {
  macrocycleNum: number;
  workoutNum: number;
  date: Date;
  lift: string;
  /** Which occurrence of `lift` in its workout, from 0 (#1027). Absent means 0. */
  occurrence?: number;
  setNum: number;
}

type LoggedSet = LiftRecordKey & { weight: number; reps: number; complex?: string | null };

/**
 * Returns the stringified natural key for a lift record:
 * `"<macrocycleNum>:<workoutNum>:<YYYYMMDD>:<lift>:<setNum>"`
 *
 * The natural key uniquely identifies a set within a (userId, program) scope.
 * It mirrors the `@@unique` constraint in the Prisma schema:
 * `(userId, program, macrocycleNum, workoutNum, date, lift, occurrence, setNum)`.
 * `userId` and `program` are omitted here because callers always operate within
 * a single user/program context.
 *
 * `date` is included (issue #884): two real workout sets can otherwise
 * legitimately share the same (macrocycleNum, workoutNum, lift, setNum) tuple on
 * different real calendar dates — e.g. a macrocycle-numbering reset, a multi-year
 * gap, or historical spreadsheet drift — and without `date` in the key,
 * `skipDuplicates` silently kept one and dropped the other. `date` is encoded
 * as a compact `YYYYMMDD` (no internal delimiter) rather than `YYYY-MM-DD`
 * because real lift names in this app already legitimately contain both `:`
 * and `-` (e.g. "Chin-up", "Romanian Dead-lift") — an all-digit, delimiter-free
 * segment drops into the existing fixed-position parsing scheme below without
 * adding new ambiguity.
 *
 * `occurrence` (issue #1027) rides on the last segment as `<setNum>~<occurrence>`,
 * and only above 0, so every key minted before it existed still names the same
 * record. The last segment is the one a lift name cannot reach.
 *
 * Example: `liftRecordNaturalKey({ macrocycleNum: 3, workoutNum: 2, date: new Date('2026-08-17'), lift: 'Bench Press', setNum: 1 })`
 * returns `"3:2:20260817:Bench Press:1"`; with `occurrence: 1`, `"3:2:20260817:Bench Press:1~1"`.
 */
export function liftRecordNaturalKey(r: LiftRecordKey): string {
  return `${r.macrocycleNum}:${r.workoutNum}:${formatDateYYYYMMDD(r.date)}:${r.lift}:${liftRecordSetSegment(r)}`;
}

/**
 * The sets a duplicate check counts together (proposal decision 13): one date, one lift under any
 * of its spellings (#1135), one set number. Macrocycle and workout numbers are left out, because a
 * file's numbers don't name stored macrocycles.
 */
function setSlotKey(r: Pick<LiftRecordKey, 'date' | 'lift' | 'setNum'>): string {
  return `${formatDateYYYYMMDD(r.date)}|${liftSpellings(r.lift)[0] ?? r.lift}|${r.setNum}`;
}

/**
 * A set slot split by complex (#1494): a set done in a complex pairs only with stored sets of the
 * same complex, and a lift's own set only with its own sets, though both can share a set number.
 */
function pairingSlotKey(r: Pick<LoggedSet, 'date' | 'lift' | 'setNum' | 'complex'>): string {
  return `${setSlotKey(r)}|${r.complex ?? ''}`;
}

/** The dates and lifts {@link classifyLiftRecordRows} needs stored sets for. */
export type SetSlot = Pick<LiftRecordKey, 'date' | 'lift'>;

/**
 * A lift-record row as one import classifies it: `occurrence` is the one it's stored under, and
 * `paired` the stored set a skipped row paired with, if any.
 */
export type ClassifiedLiftRecordRow<T, S extends LoggedSet = LoggedSet> = ClassifiedRow<T> & { occurrence: number; paired?: S };

type Pairs = (stored: LoggedSet, row: LoggedSet) => boolean;
const sameWorkout: Pairs = (s, r) => s.workoutNum === r.workoutNum;
const sameSet: Pairs = (s, r) => s.weight === r.weight && s.reps === r.reps;

/** How file rows pair with stored rows in one slot, closest match first. */
const PAIRING_PASSES: readonly Pairs[] = [(s, r) => sameWorkout(s, r) && sameSet(s, r), sameSet, sameWorkout, () => true];

/**
 * Classifies lift-record rows for one import by counting (proposal decision 13): every path that
 * previews or commits one goes through this, so they report the same counts. `stored` is every set
 * the user has stored on the file's dates and lifts, under any program and any spelling of the
 * lift. Rows are compared per date, lift and set number, and only the file's rows beyond the
 * stored count are created:
 *
 * - A row repeating an earlier row of the file, with the same set (any spelling of the lift),
 *   macrocycle and workout number, occurrence, weight and reps, is a skip. Within one file its
 *   numbers are consistent, so two same-day workouts that repeat a set keep both rows, as before
 *   #1199, and so do two sets the file's `Occurrence` column tells apart.
 * - The file's rows then pair with stored rows, closest match first: the same workout number with
 *   identical weight and reps, then identical weight and reps, then the same workout number. The
 *   rows left over are the real extras, so a workout logged in the app pairs with its own row in
 *   a sheet that also holds the day's other workout. A paired row is a skip, even when its weight
 *   or reps differ from the stored row's, which stays as stored.
 * - An extra row keeps its occurrence unless a stored row with its workout number, or an earlier
 *   extra with its macrocycle and workout numbers, has it, and then takes the highest of those + 1.
 *   Those are the rows it could collide with under the unique key, which holds the workout
 *   number; an extra in another workout keeps its occurrence, so the workout page doesn't show
 *   it as a second time through the lift.
 * - A set done in a complex (#1494) is compared only with sets of the same complex, and a lift's
 *   own set only with its own sets. A lift's own sets take their occurrences first, so a complex
 *   set sharing their set number takes the next one, whatever the file's order.
 *   A lift's own extra counts up from its own sets' occurrences, not from a stored complex set's,
 *   which the app logs at the top of the range (#1496), and skips any occurrence one holds.
 *
 * `key` is the row's natural key under the occurrence it's stored with.
 */
export function classifyLiftRecordRows<T, S extends LoggedSet = LoggedSet>(
  rows: readonly T[],
  recordOf: (row: T) => LoggedSet,
  stored: readonly S[],
): ClassifiedLiftRecordRow<T, S>[] {
  const storedBySlot = new Map<string, S[]>();
  // The occurrences a created row could collide with under the unique key, which holds the
  // workout number but not the complex: stored rows' by set slot and workout, and earlier created
  // rows' by set slot and the file's macrocycle and workout, since each file macrocycle lands in a
  // macrocycle of its own.
  const storedTaken = new Map<string, Map<number, Set<number>>>();
  // The same, without stored complex sets (#1496): a lift's own row moves past its own sets only, as
  // a complex set logged in the app sits at the top of the range (`complexSetKey`).
  const storedOwnTaken = new Map<string, Map<number, Set<number>>>();
  const createdTaken = new Map<string, Map<string, Set<number>>>();
  for (const s of stored) {
    const slot = pairingSlotKey(s);
    storedBySlot.set(slot, [...(storedBySlot.get(slot) ?? []), s]);
    const byWorkout = storedTaken.get(setSlotKey(s)) ?? new Map<number, Set<number>>();
    storedTaken.set(setSlotKey(s), byWorkout);
    byWorkout.set(s.workoutNum, (byWorkout.get(s.workoutNum) ?? new Set<number>()).add(s.occurrence ?? 0));
    if (s.complex) continue;
    const ownByWorkout = storedOwnTaken.get(setSlotKey(s)) ?? new Map<number, Set<number>>();
    storedOwnTaken.set(setSlotKey(s), ownByWorkout);
    ownByWorkout.set(s.workoutNum, (ownByWorkout.get(s.workoutNum) ?? new Set<number>()).add(s.occurrence ?? 0));
  }

  // Exact repeats within the file go first; the rest are grouped by slot, in file order.
  const seen = new Set<string>();
  const kinds = new Map<number, 'skip' | 'create'>();
  const bySlot = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const r = recordOf(row);
    const slot = pairingSlotKey(r);
    const repeat = `${slot}|${r.macrocycleNum}|${r.workoutNum}|${r.occurrence ?? 0}|${r.weight}|${r.reps}`;
    if (seen.has(repeat)) {
      kinds.set(i, 'skip');
      return;
    }
    seen.add(repeat);
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), i]);
  });

  const occurrences = new Map<number, number>();
  const pairedWith = new Map<number, S>();
  // A lift's own sets go before its complex sets, whatever the file's order, so they keep their
  // occurrence and a complex set sharing a set number takes the next one (#1494).
  const slots = [...bySlot].sort(([, [a = 0]], [, [b = 0]]) => {
    const complexA = recordOf(rows[a] as T).complex ? 1 : 0;
    const complexB = recordOf(rows[b] as T).complex ? 1 : 0;
    return complexA - complexB;
  });
  for (const [slot, indexes] of slots) {
    const pool = [...(storedBySlot.get(slot) ?? [])];
    const setSlot = setSlotKey(recordOf(rows[indexes[0] ?? 0] as T));
    const storedInSlot = storedTaken.get(setSlot) ?? new Map<number, Set<number>>();
    const storedOwnInSlot = storedOwnTaken.get(setSlot) ?? new Map<number, Set<number>>();
    const createdInSlot = createdTaken.get(setSlot) ?? new Map<string, Set<number>>();
    createdTaken.set(setSlot, createdInSlot);
    // Each pass pairs the rows left with the stored rows left, closest match first: same workout
    // and identical weight and reps, then identical weight and reps, then same workout, then any.
    let unpaired = indexes;
    for (const pairs of PAIRING_PASSES) {
      unpaired = unpaired.filter((i) => {
        const r = recordOf(rows[i] as T);
        const match = pool.findIndex((s) => pairs(s, r));
        if (match === -1) return true;
        const [paired] = pool.splice(match, 1);
        if (paired) pairedWith.set(i, paired);
        kinds.set(i, 'skip');
        return false;
      });
    }
    for (const i of unpaired) {
      kinds.set(i, 'create');
      const r = recordOf(rows[i] as T);
      const group = `${r.macrocycleNum}|${r.workoutNum}`;
      const created = createdInSlot.get(group) ?? new Set<number>();
      createdInSlot.set(group, created);
      const taken = new Set([...(storedInSlot.get(r.workoutNum) ?? []), ...created]);
      const own = r.occurrence ?? 0;
      // A lift's own row counts up from its own sets, skipping any a complex set holds.
      const from = r.complex ? taken : new Set([...(storedOwnInSlot.get(r.workoutNum) ?? []), ...created]);
      let occurrence = own;
      if (taken.has(own)) {
        occurrence = Math.max(-1, ...from) + 1;
        while (taken.has(occurrence)) occurrence += 1;
      }
      created.add(occurrence);
      occurrences.set(i, occurrence);
    }
  }

  return rows.map((row, i) => {
    const r = recordOf(row);
    const occurrence = occurrences.get(i) ?? r.occurrence ?? 0;
    const paired = pairedWith.get(i);
    return {
      row,
      kind: kinds.get(i) ?? 'skip',
      key: liftRecordNaturalKey({ ...r, occurrence }),
      occurrence,
      ...(paired ? { paired } : {}),
    };
  });
}

/**
 * How many rows {@link classifyLiftRecordRows} skipped whose weight or reps differ from the stored
 * set they paired with (decision 13). The stored set stays as it is, so the lifter's change to the
 * row isn't applied.
 */
export function countChangedSkips<T, S extends LoggedSet>(
  classified: readonly ClassifiedLiftRecordRow<T, S>[],
  recordOf: (row: T) => LoggedSet,
): number {
  return classified.filter(({ kind, paired, row }) => {
    const r = recordOf(row);
    return kind === 'skip' && paired !== undefined && (paired.weight !== r.weight || paired.reps !== r.reps);
  }).length;
}

/**
 * A key's last segment: the set number, then `~occurrence` past a lift's first
 * occurrence. Every key that names one set (the natural key, the record id, the web
 * logger's draft key) ends in it.
 */
export function liftRecordSetSegment(r: Pick<LiftRecordKey, 'occurrence' | 'setNum'>): string {
  return r.occurrence ? `${r.setNum}~${r.occurrence}` : `${r.setNum}`;
}

/**
 * `{ occurrence }` above 0, else `{}`: how a record, a request or a response carries an
 * occurrence, so a lift's first occurrence keeps the shape it had before occurrences
 * existed (#1027). Spread it into the object.
 */
export function withOccurrence(occurrence: number | undefined): { occurrence?: number } {
  return occurrence ? { occurrence } : {};
}

/**
 * `{ modifications }` when there are any, else `{}`, so an unmodified record keeps the shape it
 * had before modifications existed (ADR-041). Spread it into the object.
 */
export function withModifications(modifications: string[] | undefined): { modifications?: string[] } {
  return modifications?.length ? { modifications } : {};
}

/**
 * `{ complex, complexRound }` for a set done in a complex, else `{}`, so an ordinary set keeps the
 * shape it had before complexes existed (#1494). A round with no complex is dropped. Takes a
 * stored row's nulls as absent. Spread it into the object.
 */
export function withComplex(
  complex: string | null | undefined,
  complexRound: number | null | undefined,
): { complex?: string; complexRound?: number } {
  if (!complex) return {};
  return complexRound == null ? { complex } : { complex, complexRound };
}

/**
 * A record's `complex` and `complexRound` as a database row stores them, the write side of
 * {@link withComplex}: null for an ordinary set, and a round only beside a complex.
 */
export function complexColumns(r: { complex?: string | null; complexRound?: number | null }): {
  complex: string | null;
  complexRound: number | null;
} {
  const { complex = null, complexRound = null } = withComplex(r.complex, r.complexRound);
  return { complex, complexRound };
}

/** Inverse of {@link liftRecordSetSegment}; null when malformed. Occurrence 0 is left absent. */
function parseSetSegment(segment: string): { setNum: number; occurrence?: number } | null {
  const [set = '', occ, ...extra] = segment.split('~');
  const setNum = parseInt(set, 10);
  if (isNaN(setNum) || extra.length > 0) return null;
  if (occ === undefined) return { setNum };
  const occurrence = parseInt(occ, 10);
  if (isNaN(occurrence) || occurrence < 0) return null;
  return occurrence === 0 ? { setNum } : { setNum, occurrence };
}

/**
 * Inverse of {@link liftRecordNaturalKey}. Returns null for malformed keys.
 *
 * The lift field may contain colons (e.g. "Cool:Down") or hyphens (e.g.
 * "Chin-up"), so only the first two, the date, and the last segment are
 * fixed-position; everything in between is the lift name.
 */
export function parseLiftRecordNaturalKey(key: string): LiftRecordKey | null {
  const parts = key.split(':');
  if (parts.length < 5) return null;
  const macrocycleNum = parseInt(parts[0] ?? '', 10);
  const workoutNum = parseInt(parts[1] ?? '', 10);
  const date = parseYYYYMMDD(parts[2] ?? '');
  const set = parseSetSegment(parts[parts.length - 1] ?? '');
  const lift = parts.slice(3, parts.length - 1).join(':');
  if (isNaN(macrocycleNum) || isNaN(workoutNum) || !date || !set || !lift) return null;
  return { macrocycleNum, workoutNum, date, lift, ...set };
}

/**
 * Builds the public API id for a lift record:
 * `"<program>-<macrocycleNum>-<workoutNum>-<YYYYMMDD>-<lift>-<setNum>"`.
 *
 * Shared by the Prisma-row mapper and the in-memory adapter's id lookup so
 * the two can never independently drift on format — before issue #884, each
 * adapter hand-rolled its own copy of this same template literal, and that
 * duplication is part of how the natural key's missing `date` field went
 * unnoticed in the public id scheme too. `program` is included (unlike the
 * natural key) because the id must be addressable via
 * `PATCH /programs/:program/lift-records/:id` without additional context. A set
 * past its lift's first occurrence ends in `<setNum>~<occurrence>`, as in the
 * natural key (#1027); `~` needs no escaping in a URL path.
 */
export function buildLiftRecordId(program: string, r: LiftRecordKey): string {
  return `${program}-${r.macrocycleNum}-${r.workoutNum}-${formatDateYYYYMMDD(r.date)}-${r.lift}-${liftRecordSetSegment(r)}`;
}

/**
 * Inverse of {@link buildLiftRecordId}; null for a malformed id or one of another
 * program. The date is 8 digits with no internal delimiter, so it can never be
 * confused with a hyphen inside the lift name (e.g. "Chin-up"). A pre-#884 id
 * (no date segment) fails the segment count, which callers treat as "not found".
 */
export function parseLiftRecordId(program: string, id: string): LiftRecordKey | null {
  const prefix = `${program}-`;
  if (!id.startsWith(prefix)) return null;
  const parts = id.slice(prefix.length).split('-');
  if (parts.length < 5) return null;
  const macrocycleNum = parseInt(parts[0] ?? '', 10);
  const workoutNum = parseInt(parts[1] ?? '', 10);
  const date = parseYYYYMMDD(parts[2] ?? '');
  const set = parseSetSegment(parts[parts.length - 1] ?? '');
  const lift = parts.slice(3, parts.length - 1).join('-');
  if (isNaN(macrocycleNum) || isNaN(workoutNum) || !date || !set || !lift) return null;
  return { macrocycleNum, workoutNum, date, lift, ...set };
}
