import type {
  AssignSession,
  AssignStretch,
  ImportAssignResponse,
  ImportBreakdown,
  MacrocycleStatus,
} from '@lifting-logbook/types';

/**
 * The lifter's edits at the Assign step (#1256), kept apart from the server's suggestion so the
 * breakdown sent to the dry run and commit is built from them (proposal decision 17). Every
 * function here is pure.
 */

/** One macrocycle as the lifter has it: its sessions, program and status. */
export interface DraftStretch {
  id: string;
  sessions: AssignSession[];
  program: string;
  status: MacrocycleStatus | null;
  /** The lifter (or an export's `Status` column) chose the status, so no rule may change it. */
  statusChosen: boolean;
  /** An export's own program and macrocycle number, sent in place of dates. */
  file: { program: string; macrocycleNum: number } | null;
  /** The suggestion it started as, for its notes; null once a join or split changed it. */
  source: AssignStretch | null;
}

/** Where a session the rules left to the lifter goes. */
export type SessionChoice = 'earlier' | 'later' | 'non-cycle' | 'exclude';

export interface AssignDraft {
  stretches: DraftStretch[];
  /** The lifter's choice for each lone or unnumbered session, by date. */
  filed: Record<string, SessionChoice>;
  /** Whether the lifter changed anything, so discarding the draft is worth saying. */
  edited: boolean;
}

/** A session the lifter has to file: a lone session in a break, or one with no file number. */
export interface PendingSession {
  session: AssignSession;
  daysAfterPrevious: number | null;
  daysBeforeNext: number | null;
  /** In a file with macrocycle numbers, a session with no number to take. */
  unnumbered: boolean;
}

export function initialDraft(res: ImportAssignResponse): AssignDraft {
  return {
    stretches: res.stretches.map((s, i) => ({
      id: `s${i}`,
      sessions: s.sessions,
      program: s.program,
      status: s.fileStatus ?? s.status,
      statusChosen: s.fileStatus !== null,
      file: res.exported && s.fileMacrocycleNum !== null ? { program: fileProgram(s), macrocycleNum: s.fileMacrocycleNum } : null,
      source: s,
    })),
    filed: {},
    edited: false,
  };
}

function fileProgram(s: AssignStretch): string {
  return s.reasons.program.kind === 'column' ? s.reasons.program.value : s.program;
}

export function pendingSessions(res: ImportAssignResponse): PendingSession[] {
  return [
    ...res.lone.map((l) => ({ ...l, unnumbered: false })),
    ...res.unnumbered.map((session) => ({ session, daysAfterPrevious: null, daysBeforeNext: null, unnumbered: true })),
  ].sort((a, b) => a.session.date.localeCompare(b.session.date));
}

const startOf = (s: DraftStretch) => s.sessions[0]?.date ?? '';
const endOf = (s: DraftStretch) => s.sessions[s.sessions.length - 1]?.date ?? '';

/** The stretch a session filed `earlier` or `later` joins: the nearest one starting before or after it. */
function neighbour(stretches: DraftStretch[], date: string, choice: 'earlier' | 'later'): DraftStretch | undefined {
  return choice === 'earlier'
    ? stretches.filter((s) => startOf(s) < date).at(-1)
    : stretches.find((s) => startOf(s) > date);
}

/** Whether a pending session can be filed with the stretch before or after it. */
export function canFile(draft: AssignDraft, date: string, choice: 'earlier' | 'later'): boolean {
  return neighbour(draft.stretches, date, choice) !== undefined;
}

/** The stretches with every filed session in place, in date order. */
export function effectiveStretches(draft: AssignDraft, res: ImportAssignResponse): DraftStretch[] {
  const added = new Map<string, AssignSession[]>();
  for (const { session } of pendingSessions(res)) {
    const choice = draft.filed[session.date];
    if (choice !== 'earlier' && choice !== 'later') continue;
    const into = neighbour(draft.stretches, session.date, choice);
    if (into) added.set(into.id, [...(added.get(into.id) ?? []), session]);
  }
  return draft.stretches.map((s) => {
    const extra = added.get(s.id);
    return extra ? { ...s, sessions: [...s.sessions, ...extra].sort((a, b) => a.date.localeCompare(b.date)) } : s;
  });
}

function edit(draft: AssignDraft, stretches: DraftStretch[]): AssignDraft {
  return { ...draft, stretches, edited: true };
}

/**
 * Whether stretch `id`'s start can move one session: `later` gives its first session to the
 * stretch before it, `earlier` takes that stretch's last. Neither may empty a stretch.
 */
export function canMoveStart(draft: AssignDraft, id: string, direction: 'earlier' | 'later'): boolean {
  const i = draft.stretches.findIndex((s) => s.id === id);
  const before = draft.stretches[i - 1];
  const self = draft.stretches[i];
  if (i < 1 || !before || !self) return false;
  return direction === 'later' ? self.sessions.length > 1 : before.sessions.length > 1;
}

export function moveStart(draft: AssignDraft, id: string, direction: 'earlier' | 'later'): AssignDraft {
  const i = draft.stretches.findIndex((s) => s.id === id);
  const before = draft.stretches[i - 1];
  const self = draft.stretches[i];
  if (!before || !self || !canMoveStart(draft, id, direction)) return draft;
  const [nextBefore, nextSelf] =
    direction === 'later'
      ? [[...before.sessions, ...self.sessions.slice(0, 1)], self.sessions.slice(1)]
      : [before.sessions.slice(0, -1), [...before.sessions.slice(-1), ...self.sessions]];
  const stretches = draft.stretches.map((s, n) =>
    n === i - 1 ? { ...before, sessions: nextBefore } : n === i ? { ...self, sessions: nextSelf } : s,
  );
  return edit(draft, stretches);
}

/**
 * Joins stretch `id` into the one before it. Sessions on one date become one. The joined stretch
 * keeps a status the lifter chose for the earlier one; any other status was the rules' reading of
 * other sessions, so it's left for the lifter to choose.
 */
export function joinWithPrevious(draft: AssignDraft, id: string): AssignDraft {
  const i = draft.stretches.findIndex((s) => s.id === id);
  const before = draft.stretches[i - 1];
  const self = draft.stretches[i];
  if (i < 1 || !before || !self) return draft;
  const byDate = new Map(before.sessions.map((s) => [s.date, s]));
  for (const s of self.sessions) {
    const same = byDate.get(s.date);
    byDate.set(
      s.date,
      same ? { ...same, lifts: [...new Set([...same.lifts, ...s.lifts])], sets: same.sets + s.sets } : s,
    );
  }
  const joined: DraftStretch = {
    ...before,
    sessions: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    status: before.statusChosen ? before.status : null,
    source: null,
  };
  return edit(draft, draft.stretches.flatMap((s, n) => (n === i ? [] : n === i - 1 ? [joined] : [s])));
}

/** Days between two `YYYY-MM-DD` dates. */
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

/**
 * Splits stretch `id` in two at its largest gap between sessions, the earliest if several tie.
 * As with a join, a status the lifter didn't choose was the rules' reading of the whole stretch,
 * so both halves are left for the lifter to choose; a chosen one stays on both.
 */
export function splitAtLargestGap(draft: AssignDraft, id: string): AssignDraft {
  const self = draft.stretches.find((s) => s.id === id);
  if (!self || self.sessions.length < 2) return draft;
  let at = 1;
  let widest = -1;
  self.sessions.slice(1).forEach((s, i) => {
    const gap = daysBetween(self.sessions[i]?.date ?? s.date, s.date);
    if (gap > widest) [widest, at] = [gap, i + 1];
  });
  const status = self.statusChosen ? self.status : null;
  const tail = self.sessions.slice(at);
  const first: DraftStretch = { ...self, sessions: self.sessions.slice(0, at), status, source: null };
  const second: DraftStretch = { ...first, id: `${id}+${tail[0]?.date ?? at}`, sessions: tail, file: null };
  return edit(draft, draft.stretches.flatMap((s) => (s.id === id ? [first, second] : [s])));
}

export function setProgram(draft: AssignDraft, id: string, program: string): AssignDraft {
  return edit(draft, draft.stretches.map((s) => (s.id === id ? { ...s, program } : s)));
}

export function setStatus(draft: AssignDraft, id: string, status: MacrocycleStatus): AssignDraft {
  return edit(draft, draft.stretches.map((s) => (s.id === id ? { ...s, status, statusChosen: true } : s)));
}

export function fileSession(draft: AssignDraft, date: string, choice: SessionChoice): AssignDraft {
  return { ...draft, filed: { ...draft.filed, [date]: choice }, edited: true };
}

/** Keeps every break: each undecided lone session goes with the macrocycle before it, where there is one. */
export function fileAllWithEarlier(draft: AssignDraft, res: ImportAssignResponse): AssignDraft {
  const filed = { ...draft.filed };
  for (const p of pendingSessions(res)) {
    const date = p.session.date;
    if (!p.unnumbered && filed[date] === undefined && canFile(draft, date, 'earlier')) filed[date] = 'earlier';
  }
  return { ...draft, filed, edited: true };
}

/** Pairs of stretches whose dates overlap. The server refuses them unless the file is an export (decision 8). */
export function overlaps(stretches: DraftStretch[]): Array<[DraftStretch, DraftStretch]> {
  const pairs: Array<[DraftStretch, DraftStretch]> = [];
  stretches.forEach((a, i) => {
    for (const b of stretches.slice(i + 1)) {
      if (startOf(a) <= endOf(b) && startOf(b) <= endOf(a)) pairs.push([a, b]);
    }
  });
  return pairs;
}

/** What the lifter still has to decide before Preview: sessions to file, statuses, and overlaps. */
export function openDecisions(draft: AssignDraft, res: ImportAssignResponse): number {
  const unfiled = pendingSessions(res).filter((p) => draft.filed[p.session.date] === undefined).length;
  const stretches = effectiveStretches(draft, res);
  const unset = stretches.filter((s) => s.status === null).length;
  return unfiled + unset + (res.exported ? 0 : overlaps(stretches).length);
}

/** The confirmed breakdown, once nothing is left to decide. */
export function buildBreakdown(draft: AssignDraft, res: ImportAssignResponse): ImportBreakdown {
  const datesFiled = (choice: SessionChoice) =>
    Object.entries(draft.filed)
      .filter(([, c]) => c === choice)
      .map(([date]) => date)
      .sort();
  return {
    stretches: effectiveStretches(draft, res).map((s) => ({
      program: s.program,
      status: s.status ?? 'unknown',
      statusChosen: s.statusChosen,
      ...(s.file ? { file: s.file } : { dates: s.sessions.map((x) => x.date) }),
    })),
    excludedDates: datesFiled('exclude'),
    nonCycleDates: datesFiled('non-cycle'),
  };
}

/** A stretch is settled when nothing about it asks for the lifter's attention. */
export function isSettled(s: DraftStretch, overlapping: ReadonlySet<string>): boolean {
  return (
    s.status !== null &&
    !overlapping.has(s.id) &&
    (s.source === null || (s.source.matched && s.source.liftsOutsideProgram.length === 0))
  );
}

/** `2025-02-03` as "Feb 3, 2025", read as a calendar day. */
export function fmtDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The name every control of a stretch carries, so a screen reader knows which one it acts on. */
export function stretchName(s: DraftStretch, programName: (id: string) => string): string {
  return `${programName(s.program)} from ${fmtDay(startOf(s))}`;
}

export { startOf, endOf };
