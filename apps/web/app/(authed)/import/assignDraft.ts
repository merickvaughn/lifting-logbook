import type {
  AssignContinueMax,
  AssignLift,
  AssignSession,
  AssignStretch,
  ImportAssignResponse,
  ImportBreakdown,
  ImportBreakdownContinue,
  ImportOverwriteCounts,
  ImportOverwriteScope,
  LiftProgressionType,
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
  /** An export's own group and macrocycle number, sent in place of dates. */
  file: { group: string; macrocycleNum: number } | null;
  /** The suggestion it started as, for its notes; null once a join or split changed it. */
  source: AssignStretch | null;
}

/** Where a session the rules left to the lifter goes. */
export type SessionChoice = 'earlier' | 'later' | 'non-cycle' | 'exclude';

export interface AssignDraft {
  stretches: DraftStretch[];
  /** The lifter's choice for each lone or unnumbered session, by date. */
  filed: Record<string, SessionChoice>;
  /**
   * The progression the lifter confirmed or saved for each lift a stretch's program doesn't
   * plan, by name (#1212). It's the lift's, so one confirmation covers every stretch it's in.
   */
  confirmedLifts: Record<string, LiftProgressionType>;
  /** Continuing the offer's run as the current macrocycle (#1180), or null to keep it as history. */
  continued: ContinueDraft | null;
  /** Replacing stored history with this import (#1182, decision 19), or null to add to it, the default. */
  overwrite: OverwriteDraft | null;
  /** Whether the lifter changed anything, so discarding the draft is worth saying. */
  edited: boolean;
  /** The next stretch id's number, so a split never reuses one. */
  nextId: number;
}

/**
 * What the lifter does with a lift's training max when continuing a run (#1180, decision 10):
 * keep the current one, take the value the run's sets compute, or enter one (null until entered).
 */
export type ContinueMaxChoice = { kind: 'keep' } | { kind: 'computed' } | { kind: 'value'; weight: number | null };

/** The lifter's choices for a continued run. */
export interface ContinueDraft {
  /** Agreed to end the program's live macrocycle, which continuing ends. */
  endLive: boolean;
  /** Each lift's choice, by its stored spelling (`AssignContinueMax.lift`). */
  maxes: Record<string, ContinueMaxChoice>;
}

/** What the lifter replaces: all history, all imported history, or a date range. */
export interface OverwriteDraft {
  kind: ImportOverwriteScope['kind'];
  /** The range's first and last days, `YYYY-MM-DD`, or '' until entered. */
  from: string;
  to: string;
  /**
   * What the scope removes: the Assign response's for all or imported history, the server's
   * count for a range once it's read, or a commit's newer count. Null until there is one.
   */
  counts: ImportOverwriteCounts | null;
  /** The lifter confirmed these counts. Any change to the scope or its counts asks again. */
  confirmed: boolean;
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
      // The server pairs an export's rows by the group it put them in, not by any one cell.
      file:
        res.exported && s.fileMacrocycleNum !== null && s.fileGroup !== null
          ? { group: s.fileGroup, macrocycleNum: s.fileMacrocycleNum }
          : null,
      source: s,
    })),
    filed: {},
    confirmedLifts: {},
    continued: null,
    overwrite: null,
    edited: false,
    nextId: res.stretches.length,
  };
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

const ALL_CHOICES: readonly SessionChoice[] = ['earlier', 'later', 'non-cycle', 'exclude'];
const DATELESS_CHOICES: readonly SessionChoice[] = ['non-cycle', 'exclude'];

/**
 * The places a pending session can go. An export's stretches are sent as file macrocycles, not
 * dates, so a session with no number can't join one.
 */
export function choicesFor(p: PendingSession, res: ImportAssignResponse): readonly SessionChoice[] {
  return res.exported && p.unnumbered ? DATELESS_CHOICES : ALL_CHOICES;
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

/**
 * The draft with new stretches. A session filed with the stretch before or after it is filed
 * again by the lifter once that neighbour changes, so it never silently lands in another one.
 */
function edit(draft: AssignDraft, stretches: DraftStretch[], nextId = draft.nextId): AssignDraft {
  const filed = Object.fromEntries(
    Object.entries(draft.filed).filter(
      ([date, choice]) =>
        (choice !== 'earlier' && choice !== 'later') ||
        neighbour(draft.stretches, date, choice)?.id === neighbour(stretches, date, choice)?.id,
    ),
  );
  return { ...draft, stretches, filed, edited: true, nextId };
}

/** Sessions in date order, those on one date made one. */
function mergeSessions(sessions: readonly AssignSession[]): AssignSession[] {
  const byDate = new Map<string, AssignSession>();
  for (const s of sessions) {
    const same = byDate.get(s.date);
    byDate.set(s.date, same ? { ...same, lifts: [...new Set([...same.lifts, ...s.lifts])], sets: same.sets + s.sets } : s);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A stretch whose sessions an edit changed. A status the lifter didn't choose was the rules'
 * reading of other sessions, so it's left for the lifter to choose, and the rules' notes go.
 */
function reshaped(s: DraftStretch, sessions: AssignSession[]): DraftStretch {
  return { ...s, sessions, status: s.statusChosen ? s.status : null, source: null };
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
  // Stretches whose file numbers overlap can interleave, so the moved session is merged into
  // date order rather than put at an end.
  const [nextBefore, nextSelf] =
    direction === 'later'
      ? [mergeSessions([...before.sessions, ...self.sessions.slice(0, 1)]), self.sessions.slice(1)]
      : [before.sessions.slice(0, -1), mergeSessions([...before.sessions.slice(-1), ...self.sessions])];
  const stretches = draft.stretches.map((s, n) =>
    n === i - 1 ? reshaped(before, nextBefore) : n === i ? reshaped(self, nextSelf) : s,
  );
  return edit(draft, stretches);
}

/** The stretch `id` and the one before it, which a join keeps; null for the first. */
function withPrevious(draft: AssignDraft, id: string): { i: number; before: DraftStretch; self: DraftStretch } | null {
  const i = draft.stretches.findIndex((s) => s.id === id);
  const before = draft.stretches[i - 1];
  const self = draft.stretches[i];
  return i < 1 || !before || !self ? null : { i, before, self };
}

/** The id of the stretch a join of `id` keeps; null for the first. */
export function previousStretchId(draft: AssignDraft, id: string): string | null {
  return withPrevious(draft, id)?.before.id ?? null;
}

/**
 * Joins stretch `id` into the one before it. Sessions on one date become one. The joined stretch
 * keeps a status the lifter chose for the earlier one.
 */
export function joinWithPrevious(draft: AssignDraft, id: string): AssignDraft {
  const pair = withPrevious(draft, id);
  if (!pair) return draft;
  const { i, before, self } = pair;
  const joined = reshaped(before, mergeSessions([...before.sessions, ...self.sessions]));
  return edit(draft, draft.stretches.flatMap((s, n) => (n === i ? [] : n === i - 1 ? [joined] : [s])));
}

/** Days between two `YYYY-MM-DD` dates. */
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

/**
 * Splits stretch `id` in two at its largest gap between sessions, the earliest if several tie.
 * As with a join, both halves are left for the lifter to choose a status, unless they chose one,
 * which stays on both.
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
  return splitAt(draft, id, self.sessions[at]?.date ?? '');
}

/**
 * Splits stretch `id` so a new one starts at its session on `date` (#1174), as accepting a
 * boundary suggestion does. Both halves are left for the lifter to choose a status, as with
 * {@link splitAtLargestGap}. Unchanged when `date` isn't one of its sessions after the first.
 */
export function splitAt(draft: AssignDraft, id: string, date: string): AssignDraft {
  const self = draft.stretches.find((s) => s.id === id);
  const at = self ? self.sessions.findIndex((s) => s.date === date) : -1;
  if (!self || at < 1) return draft;
  const first = reshaped(self, self.sessions.slice(0, at));
  const second: DraftStretch = { ...reshaped(self, self.sessions.slice(at)), id: `s${draft.nextId}`, file: null };
  return edit(
    draft,
    draft.stretches.flatMap((s) => (s.id === id ? [first, second] : [s])),
    draft.nextId + 1,
  );
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

/**
 * The lifts in stretch `s` that its program doesn't plan, in the order its sessions first have
 * them (#1212). With no spec row to take a progression from, each needs the lifter's confirmation.
 */
export function outsideLifts(s: DraftStretch, res: ImportAssignResponse): AssignLift[] {
  const byName = liftsByName(res);
  const names = new Set(s.sessions.flatMap((x) => x.lifts));
  return [...names].flatMap((name) => {
    const lift = byName.get(name);
    return lift && !lift.programs.includes(s.program) ? [lift] : [];
  });
}

/** `res.lifts` by name, built once per response: it's read for every stretch on every render. */
const liftDirectories = new WeakMap<ImportAssignResponse, ReadonlyMap<string, AssignLift>>();
function liftsByName(res: ImportAssignResponse): ReadonlyMap<string, AssignLift> {
  let byName = liftDirectories.get(res);
  if (!byName) {
    byName = new Map(res.lifts.map((l) => [l.name, l]));
    liftDirectories.set(res, byName);
  }
  return byName;
}

/** Whether the lifter has confirmed `name`. An own-property check: a lift's name is free text. */
export function isConfirmed(draft: AssignDraft, name: string): boolean {
  return Object.hasOwn(draft.confirmedLifts, name);
}

/** The lift's progression as the lifter has it: confirmed or saved, else the server's preselection. */
export function liftProgression(draft: AssignDraft, lift: AssignLift): LiftProgressionType {
  return (isConfirmed(draft, lift.name) ? draft.confirmedLifts[lift.name] : undefined) ?? lift.progression;
}

/** `set` with `key` added (`on`) or removed. */
export function withMember<T>(set: ReadonlySet<T>, key: T, on: boolean): ReadonlySet<T> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

export function confirmLift(draft: AssignDraft, name: string, progression: LiftProgressionType): AssignDraft {
  return { ...draft, confirmedLifts: { ...draft.confirmedLifts, [name]: progression }, edited: true };
}

/** Names of the lifts outside `stretches`' programs that the lifter hasn't confirmed. */
function unconfirmedLifts(draft: AssignDraft, stretches: readonly DraftStretch[], res: ImportAssignResponse): Set<string> {
  return new Set(
    stretches.flatMap((s) => outsideLifts(s, res).map((l) => l.name)).filter((name) => !isConfirmed(draft, name)),
  );
}

// ---------------------------------------------------------------------------
// Continuing the last run as the current macrocycle (#1180, decisions 2 and 10)
// ---------------------------------------------------------------------------

/**
 * Where the stretch the server offered to continue is among `stretches` (the effective ones),
 * while the offer still holds, else -1: it's the last stretch, with the offer's sessions and
 * program. An edit that changes any of that withdraws the offer, since the server's checks and
 * computed maxes were for that run.
 */
function continueIndex(stretches: readonly DraftStretch[], res: ImportAssignResponse): number {
  const offer = res.continue;
  const source = offer ? res.stretches[offer.stretch] : undefined;
  const index = stretches.length - 1;
  const last = stretches[index];
  if (!source || !last || last.source !== source || last.program !== source.program) return -1;
  return last.sessions.length === source.sessions.length ? index : -1;
}

/** The stretch the server offered to continue, while the offer still holds ({@link continueIndex}). */
export function continueTarget(
  draft: AssignDraft,
  res: ImportAssignResponse,
  stretches: readonly DraftStretch[] = effectiveStretches(draft, res),
): DraftStretch | null {
  return stretches[continueIndex(stretches, res)] ?? null;
}

/** The run being continued, or null when it isn't (or the offer no longer holds). */
export function continuing(
  draft: AssignDraft,
  res: ImportAssignResponse,
  stretches: readonly DraftStretch[] = effectiveStretches(draft, res),
): DraftStretch | null {
  return draft.continued ? continueTarget(draft, res, stretches) : null;
}

/**
 * The draft after an edit, without a continue its edit withdrew. Its choices, among them the
 * agreement to end a live macrocycle, were for that offer, so they don't come back on their own
 * if a later edit makes the run match the offer again.
 */
export function withoutWithdrawnContinue(draft: AssignDraft, res: ImportAssignResponse): AssignDraft {
  return draft.continued && !continueTarget(draft, res) ? { ...draft, continued: null } : draft;
}

/**
 * The default choice for a lift: keep the current max (decision 10). A lift with no max has none
 * to keep, so it starts on the computed value when there is one, else on a value to enter.
 */
export function defaultMaxChoice(max: AssignContinueMax): ContinueMaxChoice {
  if (max.current !== null) return { kind: 'keep' };
  return max.computed !== null ? { kind: 'computed' } : { kind: 'value', weight: null };
}

/** The lift's choice as the lifter has it. */
export function maxChoice(draft: AssignDraft, max: AssignContinueMax): ContinueMaxChoice {
  return (draft.continued && Object.hasOwn(draft.continued.maxes, max.lift) ? draft.continued.maxes[max.lift] : undefined) ??
    defaultMaxChoice(max);
}

/** Turns continuing on or off. Off drops its choices, so turning it on again starts from the defaults. */
export function setContinuing(draft: AssignDraft, on: boolean): AssignDraft {
  return { ...draft, continued: on ? { endLive: false, maxes: {} } : null, edited: true };
}

export function setEndLive(draft: AssignDraft, endLive: boolean): AssignDraft {
  return draft.continued ? { ...draft, continued: { ...draft.continued, endLive }, edited: true } : draft;
}

export function setMaxChoice(draft: AssignDraft, lift: string, choice: ContinueMaxChoice): AssignDraft {
  return draft.continued
    ? { ...draft, continued: { ...draft.continued, maxes: { ...draft.continued.maxes, [lift]: choice } }, edited: true }
    : draft;
}

/** The weight a choice writes, or null to keep the current max. Undefined when it has none yet. */
function chosenWeight(choice: ContinueMaxChoice, max: AssignContinueMax): number | null | undefined {
  switch (choice.kind) {
    case 'keep':
      return max.current === null ? undefined : null;
    case 'computed':
      return max.computed ?? undefined;
    case 'value':
      return choice.weight !== null && choice.weight > 0 ? choice.weight : undefined;
  }
}

/** The continue decisions left: agreeing to end the live macrocycle, and each max with no value. */
function openContinueDecisions(draft: AssignDraft, res: ImportAssignResponse, continued: DraftStretch | null): number {
  const offer = res.continue;
  if (!offer || !draft.continued || !continued) return 0;
  const agreement = offer.live && !draft.continued.endLive ? 1 : 0;
  return agreement + offer.maxes.filter((m) => chosenWeight(maxChoice(draft, m), m) === undefined).length;
}

/** Replacing stored history instead of adding to it, starting with all of it (#1182). */
export function setReplacing(draft: AssignDraft, res: ImportAssignResponse, on: boolean): AssignDraft {
  const overwrite: OverwriteDraft | null = on
    ? { kind: 'all', from: '', to: '', counts: res.overwrite.all, confirmed: false }
    : null;
  return { ...draft, overwrite, edited: true };
}

/** The scope to replace. All and imported history take Assign's counts; a range waits for its own. */
export function setOverwriteKind(draft: AssignDraft, res: ImportAssignResponse, kind: OverwriteDraft['kind']): AssignDraft {
  if (!draft.overwrite) return draft;
  const counts = kind === 'range' ? null : res.overwrite[kind];
  return { ...draft, overwrite: { ...draft.overwrite, kind, counts, confirmed: false }, edited: true };
}

/** The range's days. Its counts are read again for them. */
export function setOverwriteRange(draft: AssignDraft, from: string, to: string): AssignDraft {
  if (!draft.overwrite) return draft;
  return { ...draft, overwrite: { ...draft.overwrite, from, to, counts: null, confirmed: false }, edited: true };
}

/** A range is ready to count once both days are entered, the first not after the last. */
export function rangeReady(overwrite: OverwriteDraft): boolean {
  return overwrite.from !== '' && overwrite.to !== '' && overwrite.from <= overwrite.to;
}

/** The counts the server read for `from`–`to`, unless the lifter has changed the range since. */
export function withRangeCounts(draft: AssignDraft, from: string, to: string, counts: ImportOverwriteCounts): AssignDraft {
  const o = draft.overwrite;
  if (!o || o.kind !== 'range' || o.from !== from || o.to !== to) return draft;
  return { ...draft, overwrite: { ...o, counts, confirmed: false } };
}

/** Counts a commit found, which differ from those confirmed, so the lifter confirms again. */
export function withChangedCounts(draft: AssignDraft, counts: ImportOverwriteCounts): AssignDraft {
  return draft.overwrite ? { ...draft, overwrite: { ...draft.overwrite, counts, confirmed: false } } : draft;
}

export function confirmOverwrite(draft: AssignDraft, confirmed: boolean): AssignDraft {
  return draft.overwrite ? { ...draft, overwrite: { ...draft.overwrite, confirmed }, edited: true } : draft;
}

/** The breakdown's `overwrite`, once there are counts to send. */
function breakdownOverwrite(overwrite: OverwriteDraft | null): ImportBreakdown['overwrite'] {
  if (!overwrite?.counts) return undefined;
  const scope: ImportOverwriteScope =
    overwrite.kind === 'range' ? { kind: 'range', from: overwrite.from, to: overwrite.to } : { kind: overwrite.kind };
  return { scope, counts: overwrite.counts };
}

/**
 * What the lifter still has to decide before Preview: sessions to file, statuses, overlaps, the
 * progression of each lift outside its stretch's program, a continued run's choices, and
 * confirming what a replace removes.
 */
export function openDecisions(draft: AssignDraft, res: ImportAssignResponse): number {
  const unfiled = pendingSessions(res).filter((p) => draft.filed[p.session.date] === undefined).length;
  const stretches = effectiveStretches(draft, res);
  const continued = continuing(draft, res, stretches);
  // A continued run is in progress whatever status it was given.
  const unset = stretches.filter((s) => s.status === null && s.id !== continued?.id).length;
  const lifts = unconfirmedLifts(draft, stretches, res).size;
  const replace = draft.overwrite && !(draft.overwrite.counts && draft.overwrite.confirmed) ? 1 : 0;
  return (
    unfiled +
    unset +
    lifts +
    (res.exported ? 0 : overlaps(stretches).length) +
    openContinueDecisions(draft, res, continued) +
    replace
  );
}

/** The breakdown's `continue` for the run at `index`, which the lifter continues. */
function breakdownContinue(draft: AssignDraft, res: ImportAssignResponse, index: number): ImportBreakdownContinue | undefined {
  const offer = res.continue;
  if (!offer || !draft.continued) return undefined;
  const maxes = offer.maxes.flatMap((m) => {
    const weight = chosenWeight(maxChoice(draft, m), m);
    return typeof weight === 'number' ? [{ lift: m.lift, weight }] : [];
  });
  // An empty live macrocycle is removed rather than ended (#1354), and the agreement says which.
  const live = draft.continued.endLive ? offer.live : null;
  const agreed = !live ? {} : live.sets === 0 ? { removeLive: live.id } : { endLive: live.id };
  return { stretch: index, ...agreed, maxes };
}

/** The confirmed breakdown, once nothing is left to decide. */
export function buildBreakdown(draft: AssignDraft, res: ImportAssignResponse): ImportBreakdown {
  const datesFiled = (choice: SessionChoice) =>
    Object.entries(draft.filed)
      .filter(([, c]) => c === choice)
      .map(([date]) => date)
      .sort();
  const stretches = effectiveStretches(draft, res);
  const index = draft.continued ? continueIndex(stretches, res) : -1;
  const continueChoice = index >= 0 ? breakdownContinue(draft, res, index) : undefined;
  const overwrite = breakdownOverwrite(draft.overwrite);
  return {
    stretches: stretches.map((s, i) => ({
      program: s.program,
      // The server stores a continued run in progress whatever it's sent.
      ...(i === index
        ? { status: 'in-progress' as const, statusChosen: false }
        : { status: s.status ?? 'unknown', statusChosen: s.statusChosen }),
      ...(s.file ? { file: s.file } : { dates: s.sessions.map((x) => x.date) }),
    })),
    excludedDates: datesFiled('exclude'),
    nonCycleDates: datesFiled('non-cycle'),
    ...(continueChoice ? { continue: continueChoice } : {}),
    ...(overwrite ? { overwrite } : {}),
  };
}

/**
 * A stretch is settled when nothing about it asks for the lifter's attention. One the rules
 * left unmatched for lifts outside its program counts as matched once the lifter has confirmed
 * each lift its program doesn't plan (#1212); one unmatched for a `Program` naming no known
 * program still needs the lifter to look at it.
 */
export function isSettled(
  s: DraftStretch,
  overlapping: ReadonlySet<string>,
  draft: AssignDraft,
  res: ImportAssignResponse,
): boolean {
  return (
    s.status !== null &&
    !overlapping.has(s.id) &&
    unconfirmedLifts(draft, [s], res).size === 0 &&
    (s.source === null ||
      s.source.matched ||
      (s.source.liftsOutsideProgram.length > 0 && !namesUnknownProgram(s.source)))
  );
}

function namesUnknownProgram(s: AssignStretch): boolean {
  const reason = s.reasons.program;
  return reason.kind === 'column' && !reason.known;
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
