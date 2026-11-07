import { liftSpellings } from '../../catalog/builtInLift';
import { formatDateYYYYMMDD, parseYYYYMMDD } from '../jsUtil';
import { type ClassifiedRow, classifyImportRows } from './classifyAndCount';

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

type LoggedSet = LiftRecordKey & { weight: number; reps: number };

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
 * What two rows share when they are the same set under different spellings of the lift: the
 * natural key with one spelling standing in for all of them, plus weight and reps.
 *
 * Weight and reps are part of it because another spelling isn't always the same set: one day can
 * hold `Pull-up` and `Weighted Pull-ups` as two slots, and both are the catalog's `pull-up`.
 */
function sameSetKey(r: LoggedSet): string {
  return `${liftRecordNaturalKey({ ...r, lift: liftSpellings(r.lift)[0] ?? r.lift })}|${r.weight}|${r.reps}`;
}

/**
 * The candidates already logged in `stored`: the same natural key, or the same set under another
 * spelling of the lift ({@link sameSetKey}). Stored rows mix spellings (#1135) and the database's
 * unique key can't see that, so `Calf Raises` and `calf-raise` on one set would otherwise both be
 * written (#947).
 */
export function findAlreadyLogged<R extends LoggedSet>(
  candidates: readonly R[],
  stored: readonly LoggedSet[],
): R[] {
  const exact = new Set(stored.map(liftRecordNaturalKey));
  const sameSet = new Set(stored.map(sameSetKey));
  return candidates.filter((r) => exact.has(liftRecordNaturalKey(r)) || sameSet.has(sameSetKey(r)));
}

/**
 * Classifies lift-record rows for one import: every path that previews or commits one goes through
 * this, so they report the same counts. A row is a skip when its natural key is in `stored` or
 * earlier in the file, or when an earlier row being created is the same set under another spelling
 * (#1191).
 *
 * Each row keeps its own natural key as `key`, including one skipped for another spelling, because
 * that's the key it would be stored under. `stored` should come from `findExistingRecords`, which
 * returns the candidates already logged, so a row stored under another spelling is matched there.
 */
export function classifyLiftRecordRows<T>(
  rows: readonly T[],
  recordOf: (row: T) => LoggedSet,
  stored: readonly LiftRecordKey[],
): Generator<ClassifiedRow<T>> {
  const storedKeys = new Set(stored.map(liftRecordNaturalKey));
  const creating = new Set<string>();
  return classifyImportRows(
    rows,
    (row) => liftRecordNaturalKey(recordOf(row)),
    (row, key) => {
      if (storedKeys.has(key)) return 'skip';
      const set = sameSetKey(recordOf(row));
      if (creating.has(set)) return 'skip';
      creating.add(set);
      return 'create';
    },
  );
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
