import { formatDateYYYYMMDD, parseYYYYMMDD } from '../jsUtil';

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
