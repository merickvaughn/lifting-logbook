import { formatDateYYYYMMDD, parseYYYYMMDD } from '../jsUtil';

/**
 * Returns the stringified natural key for a lift record:
 * `"<cycleNum>:<workoutNum>:<YYYYMMDD>:<lift>:<setNum>"`
 *
 * The natural key uniquely identifies a set within a (userId, program) scope.
 * It mirrors the `@@unique` constraint in the Prisma schema:
 * `(userId, program, cycleNum, workoutNum, date, lift, setNum)`.
 * `userId` and `program` are omitted here because callers always operate within
 * a single user/program context.
 *
 * `date` is included (issue #884): two real workout sets can otherwise
 * legitimately share the same (cycleNum, workoutNum, lift, setNum) tuple on
 * different real calendar dates — e.g. a cycle-numbering reset, a multi-year
 * gap, or historical spreadsheet drift — and without `date` in the key,
 * `skipDuplicates` silently kept one and dropped the other. `date` is encoded
 * as a compact `YYYYMMDD` (no internal delimiter) rather than `YYYY-MM-DD`
 * because real lift names in this app already legitimately contain both `:`
 * and `-` (e.g. "Chin-up", "Romanian Dead-lift") — an all-digit, delimiter-free
 * segment drops into the existing fixed-position parsing scheme below without
 * adding new ambiguity.
 *
 * Example: `liftRecordNaturalKey({ cycleNum: 3, workoutNum: 2, date: new Date('2026-08-17'), lift: 'Bench Press', setNum: 1 })`
 * returns `"3:2:20260817:Bench Press:1"`.
 */
export function liftRecordNaturalKey(r: {
  cycleNum: number;
  workoutNum: number;
  date: Date;
  lift: string;
  setNum: number;
}): string {
  return `${r.cycleNum}:${r.workoutNum}:${formatDateYYYYMMDD(r.date)}:${r.lift}:${r.setNum}`;
}

/**
 * Inverse of {@link liftRecordNaturalKey}. Returns null for malformed keys.
 *
 * The lift field may contain colons (e.g. "Cool:Down") or hyphens (e.g.
 * "Chin-up"), so only the first two, the date, and the last segment are
 * fixed-position; everything in between is the lift name.
 */
export function parseLiftRecordNaturalKey(key: string): {
  cycleNum: number;
  workoutNum: number;
  date: Date;
  lift: string;
  setNum: number;
} | null {
  const parts = key.split(':');
  if (parts.length < 5) return null;
  const cycleNum = parseInt(parts[0] ?? '', 10);
  const workoutNum = parseInt(parts[1] ?? '', 10);
  const date = parseYYYYMMDD(parts[2] ?? '');
  const setNum = parseInt(parts[parts.length - 1] ?? '', 10);
  const lift = parts.slice(3, parts.length - 1).join(':');
  if (isNaN(cycleNum) || isNaN(workoutNum) || !date || isNaN(setNum) || !lift) return null;
  return { cycleNum, workoutNum, date, lift, setNum };
}

/**
 * Builds the public API id for a lift record:
 * `"<program>-<cycleNum>-<workoutNum>-<YYYYMMDD>-<lift>-<setNum>"`.
 *
 * Shared by the Prisma-row mapper and the in-memory adapter's id lookup so
 * the two can never independently drift on format — before issue #884, each
 * adapter hand-rolled its own copy of this same template literal, and that
 * duplication is part of how the natural key's missing `date` field went
 * unnoticed in the public id scheme too. `program` is included (unlike the
 * natural key) because the id must be addressable via
 * `PATCH /programs/:program/lift-records/:id` without additional context.
 */
export function buildLiftRecordId(
  program: string,
  r: { cycleNum: number; workoutNum: number; date: Date; lift: string; setNum: number },
): string {
  return `${program}-${r.cycleNum}-${r.workoutNum}-${formatDateYYYYMMDD(r.date)}-${r.lift}-${r.setNum}`;
}
