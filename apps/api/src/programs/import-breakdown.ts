import { BadRequestException } from '@nestjs/common';
import {
  ImportBreakdown,
  ImportBreakdownStretch,
  MACROCYCLE_STATUSES,
  NON_CYCLE_PROGRAM,
  MacrocycleStatus,
} from '@lifting-logbook/types';
import {
  ClassifiedLiftRecordRow,
  ImportPreImage,
  KnownProgram,
  LiftRecord,
  buildLiftRecordsPreImage,
  classifyLiftRecordRows,
  fileMacrocycleKey,
  isNonCycleProgram,
  liftKey,
  liftRecordNaturalKey,
  pairWithRowNumber,
  toUTCMidnight,
  withOccurrence,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';
import { BatchMacrocycles } from '../ports/IImportBatchRepository';
import { NewMacrocycle } from '../ports/IMacrocycleRepository';
import { dashboardOrNull, ensureCurrentRow, moveUnstartedRows, nonCycleRowsPreImage } from './macrocycle-history.util';
import { renumberProgram } from './macrocycle-renumbering';
import { placeNonCycleRows } from './import-handlers';
import { programCoveringDate } from './import-assign';
import { StoredPlacement, continuedWorkoutNum, placeOnStored, recomputeMacrocycles } from './import-stored';

/**
 * An import through the Assign step (#1254, proposal decisions 3, 5, 13, 15 and 17): the lifter's
 * confirmed breakdown of a lift-records file into macrocycles, checked against the file and stored.
 */

// Lift-record dates are UTC midnights.
const ymd = (date: Date) => date.toISOString().slice(0, 10);

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && ymd(day) === value;
}

/** How a breakdown can fail to match its file. It names no date or program, so it can be logged. */
export type BreakdownMismatchReason =
  | 'unknown-program'
  | 'file-macrocycle-not-export'
  | 'date-not-in-file'
  | 'date-twice'
  | 'file-macrocycle-not-in-file'
  | 'file-macrocycle-twice'
  | 'date-takes-file-sessions'
  | 'sessions-left-out'
  | 'stretches-overlap';

/** The breakdown doesn't match the file: the wizard goes back to Assign for a fresh result. */
export class BreakdownMismatchException extends BadRequestException {
  constructor(
    readonly reason: BreakdownMismatchReason,
    message: string,
  ) {
    super({ statusCode: 400, code: 'breakdown-mismatch', reason, message, error: 'Bad Request' });
  }
}

function mismatch(reason: BreakdownMismatchReason, message: string): BreakdownMismatchException {
  return new BreakdownMismatchException(reason, message);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Reads the request's `breakdown` field, or null when there's none. This checks its shape only;
 * {@link placeBreakdown} checks it against the file.
 */
export function parseBreakdown(field: string | undefined): ImportBreakdown | null {
  if (field === undefined || field === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(field);
  } catch {
    throw new BadRequestException('breakdown must be JSON');
  }
  if (!isRecord(value) || !Array.isArray(value.stretches)) {
    throw new BadRequestException('breakdown must have a list of stretches');
  }
  const dates = (list: unknown, name: string): string[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list) || !list.every(isCalendarDate)) {
      throw new BadRequestException(`breakdown.${name} must be a list of YYYY-MM-DD dates`);
    }
    return list;
  };
  const stretches = value.stretches.map((raw: unknown, i): ImportBreakdownStretch => {
    const label = `breakdown stretch ${i + 1}`;
    if (!isRecord(raw)) throw new BadRequestException(`${label} must be an object`);
    const { program, status, statusChosen, file } = raw;
    if (typeof program !== 'string' || program.trim() === '') throw new BadRequestException(`${label} has no program`);
    if (!(MACROCYCLE_STATUSES as readonly unknown[]).includes(status)) {
      throw new BadRequestException(`${label}'s status must be one of ${MACROCYCLE_STATUSES.join(', ')}`);
    }
    if (typeof statusChosen !== 'boolean') throw new BadRequestException(`${label}'s statusChosen must be true or false`);
    const common = { program, status: status as MacrocycleStatus, statusChosen };
    if ((raw.dates === undefined) === (file === undefined)) {
      throw new BadRequestException(`${label} must name its dates or its file macrocycle, not both`);
    }
    if (file === undefined) return { ...common, dates: dates(raw.dates, `stretches[${i}].dates`) };
    if (
      !isRecord(file) ||
      typeof file.group !== 'string' ||
      typeof file.macrocycleNum !== 'number' ||
      !Number.isInteger(file.macrocycleNum)
    ) {
      throw new BadRequestException(`${label}'s file must have a group and a whole macrocycle number`);
    }
    return { ...common, file: { group: file.group, macrocycleNum: file.macrocycleNum } };
  });
  return {
    stretches,
    excludedDates: dates(value.excludedDates, 'excludedDates'),
    nonCycleDates: dates(value.nonCycleDates, 'nonCycleDates'),
  };
}

/** One confirmed stretch with the file rows it covers. */
export interface PlacedStretch {
  spec: ImportBreakdownStretch;
  rows: LiftRecord[];
  /** Its rows' first and last dates, or null when it has none. */
  span: { startDate: Date; endDate: Date } | null;
}

/** The first and last of the rows' dates, or null for no rows. */
function spanOf(rows: readonly LiftRecord[]): PlacedStretch['span'] {
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    first = Math.min(first, r.date.getTime());
    last = Math.max(last, r.date.getTime());
  }
  return rows.length === 0 ? null : { startDate: toUTCMidnight(new Date(first)), endDate: toUTCMidnight(new Date(last)) };
}

/** A breakdown checked against the file's rows. */
export interface PlacedBreakdown {
  stretches: PlacedStretch[];
  /**
   * The rows kept, in file order, each with its stretch's index, or null for a non-cycle row: the
   * file's `non-cycle` rows and the rows on its non-cycle dates.
   */
  rows: Array<{ r: LiftRecord; stretch: number | null }>;
  nonCycleSessions: number;
  excludedSessions: number;
}

/**
 * Places each of the file's rows (after Review's edits) by the breakdown: in its stretch, as a
 * non-cycle workout, or left out. Every dated session must be in exactly one place, every date
 * and file macrocycle the breakdown names must be in the file, every stretch's program must be one
 * the lifter has, and stretches may not overlap unless the file is an export (decision 8). Any
 * mismatch is a 400 naming it, before anything is written.
 *
 * An export's `fileKeys` gives each of `rows`, by position, its file macrocycle as `mode=assign`
 * grouped it (`fileMacrocycleKeys`), so its rows pair with the macrocycles the lifter saw. A row
 * that pairs goes with its macrocycle even on an excluded or non-cycle date, which can only be
 * another row's (#1256).
 */
export function placeBreakdown(
  rows: readonly LiftRecord[],
  breakdown: ImportBreakdown,
  context: { programs: ReadonlySet<string> } & (
    | { exported: true; fileKeys: ReadonlyArray<string | undefined> }
    | { exported: false }
  ),
): PlacedBreakdown {
  const fileKeys = context.exported ? context.fileKeys : [];
  breakdown.stretches.forEach((s, i) => {
    if (s.program === NON_CYCLE_PROGRAM || !context.programs.has(s.program)) {
      throw mismatch('unknown-program', `Stretch ${i + 1}'s program '${s.program}' isn't one of your programs.`);
    }
    if (s.file && !context.exported) {
      throw mismatch('file-macrocycle-not-export', `Stretch ${i + 1} names a file macrocycle, which only an exported file can.`);
    }
  });

  const fileRows = rows.filter((r) => !isNonCycleProgram(r.program));
  const fileDates = new Set(fileRows.map((r) => ymd(r.date)));
  const filePairs = new Set(fileKeys.filter((key) => key !== undefined));
  type Place = number | 'excluded' | 'non-cycle';
  const describe = (place: Place) => (typeof place === 'number' ? `stretch ${place + 1}` : `the ${place} dates`);
  const byDate = new Map<string, Place>();
  const claim = (date: string, place: Place) => {
    if (!fileDates.has(date)) {
      throw mismatch('date-not-in-file', `${describe(place)} lists ${date}, which has no session in the file.`);
    }
    const prior = byDate.get(date);
    if (prior !== undefined) throw mismatch('date-twice', `${date} is in both ${describe(prior)} and ${describe(place)}.`);
    byDate.set(date, place);
  };
  const byPair = new Map<string, number>();
  breakdown.stretches.forEach((s, i) => {
    if (!s.file) {
      for (const date of s.dates ?? []) claim(date, i);
      return;
    }
    const key = fileMacrocycleKey(s.file.group, s.file.macrocycleNum);
    if (!filePairs.has(key)) {
      throw mismatch(
        'file-macrocycle-not-in-file',
        `Stretch ${i + 1} names file macrocycle ${s.file.macrocycleNum}, which isn't in the file.`,
      );
    }
    const prior = byPair.get(key);
    if (prior !== undefined) {
      throw mismatch('file-macrocycle-twice', `Stretches ${prior + 1} and ${i + 1} name the same file macrocycle.`);
    }
    byPair.set(key, i);
  });
  for (const date of breakdown.excludedDates) claim(date, 'excluded');
  for (const date of breakdown.nonCycleDates) claim(date, 'non-cycle');

  const stretchRows: LiftRecord[][] = breakdown.stretches.map(() => []);
  const kept: PlacedBreakdown['rows'] = [];
  const unplaced = new Set<string>();
  rows.forEach((r, i) => {
    const dated = byDate.get(ymd(r.date));
    const fileKey = fileKeys[i];
    const paired = fileKey === undefined ? undefined : byPair.get(fileKey);
    // A date stretch can't take rows a file stretch names: they'd move without a word.
    if (typeof dated === 'number' && paired !== undefined && !isNonCycleProgram(r.program)) {
      throw mismatch(
        'date-takes-file-sessions',
        `Stretch ${dated + 1} lists ${ymd(r.date)}, whose sessions stretch ${paired + 1} names by file macrocycle.`,
      );
    }
    const place = isNonCycleProgram(r.program) ? 'non-cycle' : (paired ?? dated);
    if (place === 'excluded') return;
    if (place === 'non-cycle') kept.push({ r: { ...r, program: NON_CYCLE_PROGRAM }, stretch: null });
    else if (place === undefined) unplaced.add(ymd(r.date));
    else {
      stretchRows[place]?.push(r);
      kept.push({ r, stretch: place });
    }
  });
  if (unplaced.size > 0) {
    const dates = [...unplaced].sort();
    throw mismatch(
      'sessions-left-out',
      `The breakdown leaves out the sessions on ${dates.slice(0, 5).join(', ')}${dates.length > 5 ? ` and ${dates.length - 5} more` : ''}.`,
    );
  }
  const stretches: PlacedStretch[] = breakdown.stretches.map((spec, i) => {
    const placedRows = stretchRows[i] ?? [];
    return { spec, rows: placedRows, span: spanOf(placedRows) };
  });

  if (!context.exported) {
    const spans = stretches
      .flatMap(({ span }, i) => (span ? [{ i, ...span }] : []))
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    spans.forEach((span, k) => {
      const previous = spans[k - 1];
      if (previous && span.startDate.getTime() <= previous.endDate.getTime()) {
        throw mismatch('stretches-overlap', `Stretches ${previous.i + 1} and ${span.i + 1} overlap.`);
      }
    });
  }

  return {
    stretches,
    rows: kept,
    nonCycleSessions: new Set(kept.filter((k) => k.stretch === null).map((k) => ymd(k.r.date))).size,
    excludedSessions: breakdown.excludedDates.length,
  };
}

/** The program covering a date: the first stretch whose dates span it, else `fallback`. */
export function programCovering(stretches: readonly PlacedStretch[], fallback: string): (date: Date) => string {
  return programCoveringDate(
    stretches.flatMap(({ spec, span }) => (span ? [{ program: spec.program, ...span }] : [])),
    fallback,
  );
}

type Classified = ClassifiedLiftRecordRow<{ r: PlacedBreakdown['rows'][number]; row: number }, LiftRecord>;

/** A stretch's rows to create, as the plan places them. */
interface PlannedStretch {
  spec: ImportBreakdownStretch;
  /**
   * Rows to create, with their workout number and occurrence. A joining stretch's carry its
   * macrocycle's number; the others' numbers come at write time.
   */
  creating: LiftRecord[];
  startDate: Date;
  endDate: Date;
  unmatched: boolean;
  /** Where its rows go among the stored macrocycles (#1255): never `already-imported` here. */
  stored: StoredPlacement;
}

/** What a breakdown would write, read under the import lock for a commit. */
export interface BreakdownPlan {
  /** Every row in classification order: the stretches' rows, then the non-cycle ones. */
  classified: Classified[];
  stretches: PlannedStretch[];
  /** Non-cycle rows to create, with their occurrence; workout numbers come at write time. */
  nonCycle: LiftRecord[];
  /** Skipped rows whose weight or reps differ from the stored set they paired with. */
  changed: number;
}

/**
 * Classifies the breakdown's rows against what's stored, under any program (decision 13), and
 * places each stretch's new rows among the stored macrocycles (decision 14, {@link placeOnStored}).
 * Each row to create gets its workout number: the file's, else the session's position in the
 * stretch, or for a stretch joining a stored macrocycle, continuing from its highest (decision 9).
 * A stretch with nothing new writes nothing.
 */
export async function planBreakdown(
  repos: Pick<RepositoryBundle, 'liftRecord' | 'macrocycle'>,
  placed: PlacedBreakdown,
  programs: readonly KnownProgram[],
): Promise<BreakdownPlan> {
  const records = placed.rows.map(({ r }) => r);
  const classified = classifyLiftRecordRows(
    pairWithRowNumber(placed.rows),
    ({ r }) => r.r,
    await repos.liftRecord.findStoredSets(records),
  );
  const changed = classified.filter(
    ({ kind, paired, row: { r } }) => kind === 'skip' && paired && (paired.weight !== r.r.weight || paired.reps !== r.r.reps),
  ).length;
  // The rows to create, by stretch, with the occurrence each is stored under.
  const creatingIn = new Map<number | null, LiftRecord[]>();
  for (const c of classified) {
    if (c.kind !== 'create') continue;
    const { r, stretch } = c.row.r;
    const { occurrence: _fileOccurrence, ...rest } = r;
    let list = creatingIn.get(stretch);
    if (!list) creatingIn.set(stretch, (list = []));
    list.push({ ...rest, ...withOccurrence(c.occurrence) });
  }

  // A stretch with a row to create has rows, so it has a span; the others aren't placed.
  const withRows = placed.stretches.flatMap(({ spec, span, rows }, index) => {
    const raw = creatingIn.get(index) ?? [];
    const creating = raw.map((r) => ({ date: r.date, workoutNum: fileWorkoutNum(r) }));
    return span ? [{ spec, span, rows, raw, program: spec.program, creating }] : [];
  });

  const stretches: PlannedStretch[] = [];
  for (const { stretch, placement: stored } of await placeOnStored(repos, withRows, programs)) {
    const { spec, span, rows, raw } = stretch;
    if (raw.length === 0) continue;
    const sessionOf = new Map([...new Set(rows.map((r) => r.date.getTime()))].sort((a, b) => a - b).map((t, i) => [t, i + 1]));
    // A row the file left unnumbered on a day with numbered rows takes the day's lowest number,
    // the session's `workoutNum` in the `mode=assign` response (#1256).
    const dayNum = new Map<number, number>();
    for (const r of rows) {
      const num = fileWorkoutNum(r);
      const t = r.date.getTime();
      if (num !== null && num < (dayNum.get(t) ?? Infinity)) dayNum.set(t, num);
    }
    const continued = stored.kind === 'joins' ? continuedWorkoutNum(stretch.creating, stored.held) : null;
    const creating = raw.map((r) => ({
      ...r,
      program: spec.program,
      // A new macrocycle's number is given at write time.
      macrocycleNum: stored.kind === 'joins' ? stored.macrocycle.macrocycleNum : 0,
      workoutNum: continued
        ? continued(r)
        : (fileWorkoutNum(r) ?? dayNum.get(r.date.getTime()) ?? sessionOf.get(r.date.getTime()) ?? 1),
    }));
    const lifts = programs.find((p) => p.id === spec.program)?.lifts;
    stretches.push({
      spec,
      creating: distinctKeys(creating),
      ...span,
      unmatched: lifts === undefined || rows.some((r) => !lifts.has(liftKey(r.lift))),
      stored,
    });
  }
  return { classified, stretches, nonCycle: creatingIn.get(null) ?? [], changed };
}

/** A row's workout number from the file, else null. */
const fileWorkoutNum = (r: LiftRecord): number | null => (Number.isFinite(r.workoutNum) ? r.workoutNum : null);

/**
 * Gives a row whose natural key repeats an earlier one's the next free occurrence. The classifier
 * keeps rows apart by the file's numbers, and a stretch can join two of the file's macrocycles,
 * or a numbered and an unnumbered workout, onto one stored number.
 */
function distinctKeys(rows: readonly LiftRecord[]): LiftRecord[] {
  const taken = new Map<string, Set<number>>();
  const keys = new Set<string>();
  return rows.map((r) => {
    const slot = liftRecordNaturalKey({ ...r, occurrence: 0 });
    const used = taken.get(slot) ?? new Set<number>();
    taken.set(slot, used);
    let row = r;
    if (keys.has(liftRecordNaturalKey(r))) row = { ...r, ...withOccurrence(Math.max(...used) + 1) };
    used.add(row.occurrence ?? 0);
    keys.add(liftRecordNaturalKey(row));
    return row;
  });
}

/** One program's batch of an Assign import: its pre-image and the macrocycles it changed. */
export interface BreakdownBatch {
  /** Its sets' keys and, for the Source program, the non-cycle sets'. */
  preImage: ImportPreImage;
  /** The macrocycles it created and the stored ones it extended, by id (#1255, decision 14). */
  macrocycles: BatchMacrocycles;
}

/** What {@link writeBreakdown} wrote. */
export interface BreakdownWrite {
  created: number;
  /** Each program's batch, the Source program's always among them. */
  batches: Map<string, BreakdownBatch>;
}

/**
 * Writes a plan under the import lock, which the caller holds. A joining stretch's rows go onto
 * its stored macrocycle, which takes the stretch's status if the lifter chose it. Each program's
 * other stretches become `imported` macrocycles numbered past every stored one in start-date
 * order. The batch records each status it chose and what the macrocycle held before, for undo.
 * Once every program's rows and macrocycles are written, each joined macrocycle reads its dates,
 * `unmatched` and, unless its status was chosen, its suggested status again from all its rows as of
 * `importDate` (decision 14), so the macrocycle that follows it can be one this import created
 * under any program. Then each program renumbers by date (decision 3), so a stretch's file number
 * never names a stored macrocycle. The pre-image keys carry the numbers as stored after that; the
 * macrocycles are kept by id, which doesn't change.
 */
export async function writeBreakdown(
  repos: Pick<RepositoryBundle, 'liftRecord' | 'macrocycle' | 'macrocycleDashboard' | 'importBatch'>,
  sourceProgram: string,
  plan: BreakdownPlan,
  context: { programs: readonly KnownProgram[]; importDate: Date },
): Promise<BreakdownWrite> {
  const batches = new Map<string, BreakdownBatch>();
  const batchOf = (program: string): BreakdownBatch => {
    let batch = batches.get(program);
    if (!batch) batches.set(program, (batch = { preImage: {}, macrocycles: { created: [], extended: [], chosen: [] } }));
    return batch;
  };
  batchOf(sourceProgram);
  let created = 0;

  const byProgram = new Map<string, PlannedStretch[]>();
  for (const s of plan.stretches) {
    const list = byProgram.get(s.spec.program);
    if (list) list.push(s);
    else byProgram.set(s.spec.program, [s]);
  }
  const written: Array<{ program: string; batch: BreakdownBatch; records: LiftRecord[] }> = [];
  for (const [program, planned] of byProgram) {
    const batch = batchOf(program);
    const dashboard = await dashboardOrNull(repos, program);
    if (dashboard) await ensureCurrentRow(repos, dashboard);
    const storedNums = new Set((await repos.macrocycle.list(program)).map((m) => m.macrocycleNum));
    const first = Math.max(0, ...storedNums) + 1;
    const joining = planned.flatMap((s) => (s.stored.kind === 'joins' ? [{ s, macrocycle: s.stored.macrocycle }] : []));
    const ordered = planned.filter((s) => s.stored.kind !== 'joins').sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    const rows: NewMacrocycle[] = ordered.map((s, i) => ({
      program,
      macrocycleNum: first + i,
      startDate: s.startDate,
      endDate: s.endDate,
      status: s.spec.status,
      statusChosen: s.spec.statusChosen,
      origin: 'imported',
      unmatched: s.unmatched,
    }));
    if (rows.length > 0) {
      // Rows a page wrote on these numbers before they had a macrocycle move past them first.
      await moveUnstartedRows(repos, program, storedNums, first - 1, first + rows.length - 1);
      await repos.macrocycle.createMany(rows);
      const ids = new Map((await repos.macrocycle.list(program)).map((m) => [m.macrocycleNum, m.id]));
      for (const [i, s] of ordered.entries()) {
        const id = ids.get(first + i);
        if (id === undefined) throw new Error(`Macrocycle ${first + i} of ${program} was not created`);
        batch.macrocycles.created.push(id);
        // A new macrocycle had no status of its own, so the batch found it unchosen.
        if (s.spec.statusChosen) batch.macrocycles.chosen.push({ id, chose: s.spec.status, before: { statusChosen: false } });
      }
    }
    const records = [
      ...ordered.flatMap((s, i) => s.creating.map((r) => ({ ...r, macrocycleNum: first + i }))),
      ...joining.flatMap(({ s }) => s.creating),
    ];
    created += await repos.liftRecord.appendLiftRecords(program, records);
    for (const { s, macrocycle } of joining) {
      batch.macrocycles.extended.push(macrocycle.id);
      if (!s.spec.statusChosen) continue;
      await repos.macrocycle.update(macrocycle.id, { status: s.spec.status, statusChosen: true });
      batch.macrocycles.chosen.push({
        id: macrocycle.id,
        chose: s.spec.status,
        before: { status: macrocycle.status, statusChosen: macrocycle.statusChosen },
      });
    }
    written.push({ program, batch, records });
  }

  await recomputeMacrocycles(
    repos,
    written.flatMap(({ batch }) => batch.macrocycles.extended),
    context.programs,
    context.importDate,
  );
  for (const { program, batch, records } of written) {
    const changes = await renumberProgram(repos, program);
    const renumbered = (n: number) => changes.get(n) ?? n;
    Object.assign(
      batch.preImage,
      buildLiftRecordsPreImage(records.map((r) => ({ ...r, macrocycleNum: renumbered(r.macrocycleNum) }))),
    );
  }

  if (plan.nonCycle.length > 0) {
    // Rows the file kept apart by macrocycle number can share a non-cycle workout.
    const nonCycle = distinctKeys(await placeNonCycleRows(repos, plan.nonCycle));
    created += await repos.liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, nonCycle);
    // A non-cycle set's key holds no program, so the Source program's batch carries them.
    Object.assign(batchOf(sourceProgram).preImage, nonCycleRowsPreImage(nonCycle));
  }

  return { created, batches };
}
