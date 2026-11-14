import { IMPORT_SUGGESTION_MAX_SETS } from '@lifting-logbook/types';
import { LIFT_CATALOG, type SegmentedLiftHistory } from '@lifting-logbook/core';

/**
 * What an import suggestion request may send (#1174, proposal decision 11), built from the file's
 * parsed rows and the rules' grouping of them. Pure: nothing here reads a database or a clock.
 *
 * Sent: each set's date, lift name, set number, weight and reps; the rules' stretches and flags;
 * each known program's id, name and length; the import date; and each set's notes only when the
 * lifter opts in. Custom lift and program names are free text, so they go as placeholders
 * (`custom-lift-1`, `custom-program-1`), and nothing else from the file is sent: no `Program` cell,
 * no file numbers, no lift names in the rules' reasons.
 */

/** A parsed row as segmentation returns it. `LiftRecord` fields beyond `LiftHistoryRow` ride along. */
export interface SuggestionRow {
  date?: Date | null;
  lift: string;
  setNum?: number | null;
  weight?: number | null;
  reps?: number | null;
  notes?: string | null;
}

/** A program a stretch can be assigned to, as `assignProgramOptions` lists them. */
export interface SuggestionProgram {
  id: string;
  /** Null for a built-in. A custom program's own name, which is never sent. */
  name: string | null;
  workouts: number | null;
  weeks: number;
}

export interface SuggestionPayloadInput {
  segmented: SegmentedLiftHistory<SuggestionRow>;
  importDate: Date;
  /** Built-ins first, then the lifter's custom programs. */
  programs: readonly SuggestionProgram[];
  /** Whether the file is this app's export, whose boundaries the lifter can't move. */
  exported: boolean;
  /** The lifter opted to send their notes. */
  notes: boolean;
}

/** Sessions on each side of a break or flag that keep every set when a file is over the cap. */
export const SESSIONS_AROUND_FLAGS = 2;

/** One set as sent. `notes` only when the lifter opted in and the set has some. */
interface SentSet {
  lift: string;
  set: number | null;
  weight: number | null;
  reps: number | null;
  notes?: string;
}

/** A session past the cap's reach: its date, its lifts and each lift's top set. */
interface SentSummary {
  lift: string;
  weight: number | null;
  reps: number | null;
}

type SentSession = { date: string; sets: SentSet[] } | { date: string; topSets: SentSummary[] };

export interface SuggestionPayload {
  importDate: string;
  exportedFile: boolean;
  programs: Array<{ id: string; name: string; workouts: number | null; weeks: number }>;
  stretches: Array<{
    start: string;
    end: string;
    program: string;
    matched: boolean;
    status: string | null;
    startReason: string;
    sessions: number;
    completedWorkouts: number;
    expectedWorkouts: number | null;
  }>;
  flags: {
    lone: Array<{ date: string; daysAfterPrevious: number | null; daysBeforeNext: number | null }>;
    unnumbered: string[];
    conflicts: Array<{ kind: string; from?: string; to?: string; days?: number; stretches?: number[] }>;
  };
  sessions: SentSession[];
}

export interface BuiltSuggestionPayload {
  payload: SuggestionPayload;
  /** Sets the payload carries, a summary's top sets included, against {@link IMPORT_SUGGESTION_MAX_SETS}. */
  sets: number;
  /** Whether it's within the cap. When it isn't, no request may be made. */
  fits: boolean;
  summarizedSessions: number;
  /** Each lift name sent, lower-cased, to the name the lifter knows it by. */
  lifts: Map<string, string>;
  /** Each program id sent to the program's real id. */
  programs: Map<string, string>;
  /** Each placeholder sent to the real name the lifter's own screen shows. */
  placeholders: Map<string, string>;
}

const ymd = (date: Date) => date.toISOString().slice(0, 10);
const CATALOG_NAMES = new Map(LIFT_CATALOG.map((lift) => [lift.id, lift.name]));

interface Entry {
  date: Date;
  rows: SuggestionRow[];
  /** Every set is sent: an unmatched stretch, or near a break or flag. */
  keep: boolean;
}

export function buildSuggestionPayload(
  input: SuggestionPayloadInput,
  /** The lifter's names for their lifts by id, custom ones included, so a placeholder can be read back. */
  liftNames: ReadonlyMap<string, string>,
): BuiltSuggestionPayload {
  const { segmented } = input;
  const placeholders = new Map<string, string>();

  // Lifts: the catalog's name, else a placeholder numbered in order of first appearance.
  const liftSent = new Map<string, string>();
  const lifts = new Map<string, string>();
  let customLifts = 0;
  const liftName = (id: string): string => {
    let sent = liftSent.get(id);
    if (sent === undefined) {
      const catalog = CATALOG_NAMES.get(id);
      sent = catalog ?? `custom-lift-${++customLifts}`;
      liftSent.set(id, sent);
      lifts.set(sent.toLowerCase(), liftNames.get(id) ?? id);
      if (catalog === undefined) placeholders.set(sent, liftNames.get(id) ?? id);
    }
    return sent;
  };

  // Programs: a built-in's id, else a placeholder. A stretch's program may be one the list lacks.
  const programSent = new Map<string, string>();
  const programs = new Map<string, string>();
  let customPrograms = 0;
  const builtIn = new Set(input.programs.filter((p) => p.name === null).map((p) => p.id));
  const customNames = new Map(input.programs.filter((p) => p.name !== null).map((p) => [p.id, p.name ?? p.id]));
  const programId = (id: string): string => {
    let sent = programSent.get(id);
    if (sent === undefined) {
      sent = builtIn.has(id) ? id : `custom-program-${++customPrograms}`;
      programSent.set(id, sent);
      programs.set(sent, id);
      if (!builtIn.has(id)) placeholders.set(sent, customNames.get(id) ?? id);
    }
    return sent;
  };

  const sentPrograms = input.programs.map((p) => {
    const id = programId(p.id);
    return { id, name: id, workouts: p.workouts, weeks: p.weeks };
  });

  const stretches = segmented.stretches.map((s) => ({
    start: ymd(s.startDate),
    end: ymd(s.endDate),
    program: programId(s.program),
    matched: s.matched,
    status: s.status,
    startReason: s.reasons.start.kind,
    sessions: s.sessions.length,
    completedWorkouts: s.completedWorkouts,
    expectedWorkouts: s.expectedWorkouts,
  }));

  const unnumberedByDate = new Map<number, SuggestionRow[]>();
  for (const row of segmented.unnumbered) {
    if (!(row.date instanceof Date)) continue;
    const list = unnumberedByDate.get(row.date.getTime());
    if (list) list.push(row);
    else unnumberedByDate.set(row.date.getTime(), [row]);
  }

  // Every session in date order, with what decides whether it keeps every set past the cap.
  const entries: Entry[] = [];
  const stretchFirst = new Set<number>();
  const flagged = new Set<number>();
  for (const s of segmented.stretches) {
    s.sessions.forEach((session, i) => {
      if (i === 0) stretchFirst.add(entries.length);
      entries.push({ date: session.date, rows: session.rows, keep: !s.matched });
    });
  }
  for (const lone of segmented.lone) {
    flagged.add(entries.length);
    entries.push({ date: lone.session.date, rows: lone.session.rows, keep: true });
  }
  for (const [time, rows] of unnumberedByDate) {
    flagged.add(entries.length);
    entries.push({ date: new Date(time), rows, keep: true });
  }
  const order = entries.map((_, i) => i).sort((a, b) => (entries[a]?.date.getTime() ?? 0) - (entries[b]?.date.getTime() ?? 0));
  const position = new Map(order.map((entry, pos) => [entry, pos]));
  const keepAround = (pos: number) => {
    for (let p = pos - SESSIONS_AROUND_FLAGS; p <= pos + SESSIONS_AROUND_FLAGS; p++) {
      const entry = entries[order[p] ?? -1];
      if (entry) entry.keep = true;
    }
  };
  // A break sits between one stretch's last session and the next one's first: two sessions
  // before it and two after.
  stretchFirst.forEach((i) => {
    const pos = position.get(i) ?? 0;
    if (pos === 0) return;
    for (let p = pos - SESSIONS_AROUND_FLAGS; p < pos + SESSIONS_AROUND_FLAGS; p++) {
      const entry = entries[order[p] ?? -1];
      if (entry) entry.keep = true;
    }
  });
  flagged.forEach((i) => keepAround(position.get(i) ?? 0));
  for (const c of segmented.conflicts) {
    if (c.kind !== 'gap-inside-number') continue;
    for (const date of [c.from, c.to]) {
      const pos = order.findIndex((i) => entries[i]?.date.getTime() === date.getTime());
      if (pos >= 0) keepAround(pos);
    }
  }

  const fullSets = entries.reduce((n, e) => n + e.rows.length, 0);
  const overCap = fullSets > IMPORT_SUGGESTION_MAX_SETS;

  const fullSession = (e: Entry): SentSession => ({
    date: ymd(e.date),
    sets: e.rows.map((row) => {
      const set: SentSet = {
        lift: liftName(row.lift),
        set: num(row.setNum),
        weight: num(row.weight),
        reps: num(row.reps),
      };
      const notes = typeof row.notes === 'string' ? row.notes.trim() : '';
      if (input.notes && notes !== '') set.notes = notes;
      return set;
    }),
  });
  const summary = (e: Entry): SentSession => {
    const top = new Map<string, SentSummary>();
    for (const row of e.rows) {
      const lift = liftName(row.lift);
      const weight = num(row.weight);
      const reps = num(row.reps);
      const kept = top.get(lift);
      if (
        !kept ||
        (weight ?? -Infinity) > (kept.weight ?? -Infinity) ||
        (weight === kept.weight && (reps ?? -Infinity) > (kept.reps ?? -Infinity))
      ) {
        top.set(lift, { lift, weight, reps });
      }
    }
    return { date: ymd(e.date), topSets: [...top.values()] };
  };

  let sets = 0;
  let summarizedSessions = 0;
  const sessions = order.map((i) => {
    const e = entries[i] as Entry;
    if (!overCap || e.keep) {
      sets += e.rows.length;
      return fullSession(e);
    }
    const s = summary(e);
    summarizedSessions++;
    sets += 'topSets' in s ? s.topSets.length : 0;
    return s;
  });

  const payload: SuggestionPayload = {
    importDate: ymd(input.importDate),
    exportedFile: input.exported,
    programs: sentPrograms,
    stretches,
    flags: {
      lone: segmented.lone.map((l) => ({
        date: ymd(l.session.date),
        daysAfterPrevious: l.daysAfterPrevious,
        daysBeforeNext: l.daysBeforeNext,
      })),
      unnumbered: [...unnumberedByDate.keys()].sort((a, b) => a - b).map((t) => ymd(new Date(t))),
      conflicts: segmented.conflicts.map((c) =>
        c.kind === 'gap-inside-number'
          ? { kind: c.kind, from: ymd(c.from), to: ymd(c.to), days: c.days }
          : { kind: c.kind, stretches: [...c.stretches] },
      ),
    },
    sessions,
  };

  return {
    payload,
    sets,
    fits: sets <= IMPORT_SUGGESTION_MAX_SETS,
    summarizedSessions,
    lifts,
    programs,
    placeholders,
  };
}

function num(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
