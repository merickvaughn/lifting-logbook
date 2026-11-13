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
  isNonCycleProgram,
  liftKey,
  liftRecordNaturalKey,
  pairWithRowNumber,
  toUTCMidnight,
  withOccurrence,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';
import { NewMacrocycle } from '../ports/IMacrocycleRepository';
import {
  dashboardOrNull,
  ensureCurrentRow,
  legacyRowsPreImage,
  moveUnstartedRows,
  nonCycleRowsPreImage,
} from './macrocycle-history.util';
import { renumberProgram } from './macrocycle-renumbering';
import { placeNonCycleRows } from './import-handlers';

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

/** The breakdown doesn't match the file: the wizard goes back to Assign for a fresh result. */
function mismatch(message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code: 'breakdown-mismatch', message, error: 'Bad Request' });
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
      typeof file.program !== 'string' ||
      typeof file.macrocycleNum !== 'number' ||
      !Number.isInteger(file.macrocycleNum)
    ) {
      throw new BadRequestException(`${label}'s file must have a program and a whole macrocycle number`);
    }
    return { ...common, file: { program: file.program, macrocycleNum: file.macrocycleNum } };
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

/** A row's file `Program` and `Macrocycle #`, which name an exported file's macrocycle. */
const pairKey = (program: string, macrocycleNum: number) => `${program.trim()}|${macrocycleNum}`;

/**
 * Places each of the file's rows (after Review's edits) by the breakdown: in its stretch, as a
 * non-cycle workout, or left out. Every dated session must be in exactly one place, every date
 * and file macrocycle the breakdown names must be in the file, every stretch's program must be one
 * the lifter has, and stretches may not overlap unless the file is an export (decision 8). Any
 * mismatch is a 400 naming it, before anything is written.
 */
export function placeBreakdown(
  rows: readonly LiftRecord[],
  breakdown: ImportBreakdown,
  context: { exported: boolean; programs: ReadonlySet<string> },
): PlacedBreakdown {
  breakdown.stretches.forEach((s, i) => {
    if (s.program === NON_CYCLE_PROGRAM || !context.programs.has(s.program)) {
      throw mismatch(`Stretch ${i + 1}'s program '${s.program}' isn't one of your programs.`);
    }
    if (s.file && !context.exported) {
      throw mismatch(`Stretch ${i + 1} names a file macrocycle, which only an exported file can.`);
    }
  });

  const fileRows = rows.filter((r) => !isNonCycleProgram(r.program));
  const fileDates = new Set(fileRows.map((r) => ymd(r.date)));
  const filePairs = new Set(fileRows.map((r) => pairKey(String(r.program ?? ''), r.macrocycleNum)));
  type Place = number | 'excluded' | 'non-cycle';
  const describe = (place: Place) => (typeof place === 'number' ? `stretch ${place + 1}` : `the ${place} dates`);
  const byDate = new Map<string, Place>();
  const claim = (date: string, place: Place) => {
    if (!fileDates.has(date)) throw mismatch(`${describe(place)} lists ${date}, which has no session in the file.`);
    const prior = byDate.get(date);
    if (prior !== undefined) throw mismatch(`${date} is in both ${describe(prior)} and ${describe(place)}.`);
    byDate.set(date, place);
  };
  const byPair = new Map<string, number>();
  breakdown.stretches.forEach((s, i) => {
    if (!s.file) {
      for (const date of s.dates ?? []) claim(date, i);
      return;
    }
    const key = pairKey(s.file.program, s.file.macrocycleNum);
    if (!filePairs.has(key)) {
      throw mismatch(`Stretch ${i + 1} names macrocycle ${s.file.macrocycleNum} of '${s.file.program}', which isn't in the file.`);
    }
    const prior = byPair.get(key);
    if (prior !== undefined) throw mismatch(`Stretches ${prior + 1} and ${i + 1} name the same file macrocycle.`);
    byPair.set(key, i);
  });
  for (const date of breakdown.excludedDates) claim(date, 'excluded');
  for (const date of breakdown.nonCycleDates) claim(date, 'non-cycle');

  const stretches: PlacedStretch[] = breakdown.stretches.map((spec) => ({ spec, rows: [] }));
  const kept: PlacedBreakdown['rows'] = [];
  const unplaced = new Set<string>();
  for (const r of rows) {
    const place = isNonCycleProgram(r.program)
      ? 'non-cycle'
      : (byDate.get(ymd(r.date)) ?? byPair.get(pairKey(String(r.program ?? ''), r.macrocycleNum)));
    if (place === 'excluded') continue;
    if (place === 'non-cycle') kept.push({ r: { ...r, program: NON_CYCLE_PROGRAM }, stretch: null });
    else if (place === undefined) unplaced.add(ymd(r.date));
    else {
      stretches[place]?.rows.push(r);
      kept.push({ r, stretch: place });
    }
  }
  if (unplaced.size > 0) {
    const dates = [...unplaced].sort();
    throw mismatch(
      `The breakdown leaves out the sessions on ${dates.slice(0, 5).join(', ')}${dates.length > 5 ? ` and ${dates.length - 5} more` : ''}.`,
    );
  }

  if (!context.exported) {
    const spans = stretches
      .map((s, i) => ({ i, first: Math.min(...s.rows.map((r) => r.date.getTime())), last: Math.max(...s.rows.map((r) => r.date.getTime())) }))
      .sort((a, b) => a.first - b.first);
    spans.forEach((span, k) => {
      const previous = spans[k - 1];
      if (previous && span.first <= previous.last) throw mismatch(`Stretches ${previous.i + 1} and ${span.i + 1} overlap.`);
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
  const spans = stretches
    .filter((s) => s.rows.length > 0)
    .map((s) => ({
      program: s.spec.program,
      first: Math.min(...s.rows.map((r) => r.date.getTime())),
      last: Math.max(...s.rows.map((r) => r.date.getTime())),
    }));
  return (date) => spans.find((s) => s.first <= date.getTime() && date.getTime() <= s.last)?.program ?? fallback;
}

type Classified = ClassifiedLiftRecordRow<{ r: LiftRecord; row: number }, LiftRecord>;

/** A stretch's rows to create, as the plan places them. */
interface PlannedStretch {
  spec: ImportBreakdownStretch;
  /** Rows to create, with their workout number and occurrence; macrocycle numbers come at write time. */
  creating: LiftRecord[];
  startDate: Date;
  endDate: Date;
  unmatched: boolean;
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
 * gives each row to create its stretch's workout number: the file's, else the session's position
 * in the stretch (decision 9). A stretch with nothing new creates no macrocycle.
 */
export async function planBreakdown(
  repos: Pick<RepositoryBundle, 'liftRecord'>,
  placed: PlacedBreakdown,
  programs: readonly KnownProgram[],
): Promise<BreakdownPlan> {
  const records = placed.rows.map(({ r }) => r);
  const classified = classifyLiftRecordRows(pairWithRowNumber(records), ({ r }) => r, await repos.liftRecord.findStoredSets(records));
  const changed = classified.filter(
    ({ kind, paired, row: { r } }) => kind === 'skip' && paired && (paired.weight !== r.weight || paired.reps !== r.reps),
  ).length;
  // The rows to create, by stretch, with the occurrence each is stored under.
  const creatingIn = new Map<number | null, LiftRecord[]>();
  classified.forEach((c, i) => {
    if (c.kind !== 'create') return;
    const place = placed.rows[i]?.stretch ?? null;
    const { occurrence: _fileOccurrence, ...rest } = c.row.r;
    creatingIn.set(place, [...(creatingIn.get(place) ?? []), { ...rest, ...withOccurrence(c.occurrence) }]);
  });

  const stretches: PlannedStretch[] = [];
  placed.stretches.forEach(({ spec, rows }, index) => {
    const sessionOf = new Map([...new Set(rows.map((r) => r.date.getTime()))].sort((a, b) => a - b).map((t, i) => [t, i + 1]));
    const creating = (creatingIn.get(index) ?? []).map((r) => ({
        ...r,
        program: spec.program,
        // One stored macrocycle per stretch: the number is given at write time.
        macrocycleNum: 0,
        workoutNum: Number.isFinite(r.workoutNum) ? r.workoutNum : (sessionOf.get(r.date.getTime()) ?? 1),
      }));
    if (creating.length === 0) return;
    const lifts = programs.find((p) => p.id === spec.program)?.lifts;
    const times = rows.map((r) => r.date.getTime());
    stretches.push({
      spec,
      creating: distinctKeys(creating),
      startDate: toUTCMidnight(new Date(Math.min(...times))),
      endDate: toUTCMidnight(new Date(Math.max(...times))),
      unmatched: lifts === undefined || rows.some((r) => !lifts.has(liftKey(r.lift))),
    });
  });
  return { classified, stretches, nonCycle: creatingIn.get(null) ?? [], changed };
}

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

/** What {@link writeBreakdown} wrote. */
export interface BreakdownWrite {
  created: number;
  macrocycles: number;
  /** Each program's pre-image: its sets, the macrocycles created and, for the Source program, the non-cycle sets. */
  preImages: Map<string, ImportPreImage>;
}

/**
 * Writes a plan under the import lock, which the caller holds. Each program's new macrocycles are
 * `imported` rows numbered past every stored one in start-date order, then the program renumbers
 * by date (decision 3), so a stretch's file number never names a stored macrocycle. The pre-image
 * keys carry the numbers as stored after that.
 */
export async function writeBreakdown(
  repos: Pick<RepositoryBundle, 'liftRecord' | 'macrocycle' | 'macrocycleDashboard' | 'importBatch'>,
  sourceProgram: string,
  plan: BreakdownPlan,
): Promise<BreakdownWrite> {
  const preImages = new Map<string, ImportPreImage>([[sourceProgram, {}]]);
  const addTo = (program: string, image: ImportPreImage) =>
    preImages.set(program, { ...(preImages.get(program) ?? {}), ...image });
  let created = 0;

  const byProgram = new Map<string, PlannedStretch[]>();
  for (const s of plan.stretches) byProgram.set(s.spec.program, [...(byProgram.get(s.spec.program) ?? []), s]);
  for (const [program, planned] of byProgram) {
    const dashboard = await dashboardOrNull(repos, program);
    if (dashboard) await ensureCurrentRow(repos, dashboard);
    const storedNums = new Set((await repos.macrocycle.list(program)).map((m) => m.macrocycleNum));
    const first = Math.max(0, ...storedNums) + 1;
    const ordered = [...planned].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
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
    // Rows a page wrote on these numbers before they had a macrocycle move past them first.
    await moveUnstartedRows(repos, program, storedNums, first - 1, first + rows.length - 1);
    await repos.macrocycle.createMany(rows);
    const records = ordered.flatMap((s, i) => s.creating.map((r) => ({ ...r, macrocycleNum: first + i })));
    created += await repos.liftRecord.appendLiftRecords(program, records);
    const changes = await renumberProgram(repos, program);
    const renumbered = (n: number) => changes.get(n) ?? n;
    addTo(program, {
      ...buildLiftRecordsPreImage(records.map((r) => ({ ...r, macrocycleNum: renumbered(r.macrocycleNum) }))),
      ...legacyRowsPreImage(rows.map((m) => renumbered(m.macrocycleNum))),
    });
  }

  if (plan.nonCycle.length > 0) {
    const nonCycle = await placeNonCycleRows(repos, plan.nonCycle);
    created += await repos.liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, nonCycle);
    // A non-cycle set's key holds no program, so the Source program's batch carries them.
    addTo(sourceProgram, nonCycleRowsPreImage(nonCycle));
  }

  return { created, macrocycles: plan.stretches.length, preImages };
}
