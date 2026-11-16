import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import {
  AssignContinueMax,
  AssignContinueOffer,
  AssignStoredPlacement,
  ImportBreakdownContinue,
  NON_CYCLE_PROGRAM,
} from '@lifting-logbook/types';
import {
  BREAK_DAYS,
  HistoryStretch,
  ImportPreImage,
  KnownProgram,
  LiftHistoryRecord,
  LiftingProgramSpec,
  LiftRecord,
  MacrocycleDashboard,
  ProgressionSettings,
  TrainingMax,
  UpdateMaxesOptions,
  WEEKDAY_MAP,
  Weekday,
  buildTrainingMaxPreImage,
  formatDateYYYYMMDD,
  isOpenEnded,
  liftIdFor,
  liftRecordNaturalKey,
  programWorkoutKeys,
  toUTCMidnight,
  updateMaxes,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';
import { ContinuedRun, preImageKeyNumber } from '../ports/IImportBatchRepository';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import { modificationModesFor } from '../lifts/lift-modification.util';
import { closingStatus, dashboardOrNull, forgetBatchKeys, macrocycleIdFor } from './macrocycle-history.util';
import { PROGRAM_DEFAULTS, redatedScheduledWorkouts } from './macrocycle-generation.service';
import { placeNonCycleRows } from './import-handlers';

/**
 * Continuing the file's latest run as the current macrocycle (#1180, proposal decisions 2 and 10).
 * `mode=assign` offers it, the commit makes the run current, and undo puts back what it changed.
 */

const DAY_MS = 86_400_000;

const logger = new Logger('ImportContinue');

// ---------------------------------------------------------------------------
// The computed maxes (decision 10)
// ---------------------------------------------------------------------------

/** A lift the program plans, with its current max and the one the run's sets give it. */
export interface ContinueMax {
  /** As its max is stored, else as the program spells it. */
  lift: string;
  current: number | null;
  /** Null when no set of the run moves it. A lower value counts: it comes from `flagged`. */
  computed: number | null;
}

/** The program's lifts, each once in spec order, under the first spelling the spec uses. */
export function plannedLifts(programSpec: readonly LiftingProgramSpec[]): string[] {
  const seen = new Set<string>();
  return programSpec.flatMap((row) => {
    const id = liftIdFor(row.lift);
    if (seen.has(id)) return [];
    seen.add(id);
    return [row.lift];
  });
}

/**
 * Each lift the program plans, with the training max the run's sets give it (decision 10), through
 * `updateMaxes`, as recalculating at the run's end would. A lift with no max starts from zero,
 * dated the day before the run, so every lift gets a reading. One the run leaves at zero, or at its
 * current max, has no computed value. A computed value lower than the current max is one
 * `updateMaxes` flags rather than applies, so it's read from `flagged`.
 */
export function computeContinueMaxes(
  programSpec: readonly LiftingProgramSpec[],
  current: readonly TrainingMax[],
  run: readonly LiftRecord[],
  options: Omit<UpdateMaxesOptions, 'endOfMacrocycle'>,
): ContinueMax[] {
  const lifts = plannedLifts(programSpec);
  const storedFor = (lift: string) => current.find((m) => liftIdFor(m.lift) === liftIdFor(lift));
  const first = run.reduce<number>((min, r) => Math.min(min, toUTCMidnight(r.date).getTime()), Infinity);
  const seedDate = new Date((Number.isFinite(first) ? first : toUTCMidnight(new Date()).getTime()) - DAY_MS);
  const seeded = [
    ...current,
    ...lifts.filter((lift) => !storedFor(lift)).map((lift) => ({ lift, weight: 0, dateUpdated: seedDate })),
  ];
  const { maxes, flagged } = updateMaxes([...programSpec], seeded, [...run], options);
  return lifts.map((lift) => {
    const id = liftIdFor(lift);
    const stored = storedFor(lift);
    const was = stored?.weight ?? 0;
    const lower = flagged.find((f) => f.modificationId === undefined && liftIdFor(f.lift) === id);
    const after = maxes.find((m) => liftIdFor(m.lift) === id)?.weight ?? was;
    const computed = lower ? lower.proposedWeight : after !== was && after > 0 ? after : null;
    return { lift: stored?.lift ?? lift, current: stored ? stored.weight : null, computed };
  });
}

// ---------------------------------------------------------------------------
// Which run may continue (decision 2)
// ---------------------------------------------------------------------------

/** Why a run can't continue as current. None names a date or program, so each can be logged. */
export type ContinueRefusal = 'not-last' | 'unknown-program' | 'finished' | 'stale' | 'already-stored';

/** The program a run may continue under: a built-in with a known length the app can start. */
function continuableProgram(programs: readonly KnownProgram[], id: string): KnownProgram | null {
  const program = programs.find((p) => p.id === id);
  return program && !isOpenEnded(program) && program.workoutCount > 0 && PROGRAM_DEFAULTS[id] ? program : null;
}

/**
 * Why a run can't continue as current, or null when it can (decision 2): it ends last among the
 * file's stretches, it's under a program with a known length and workouts left, and its last session
 * is no more than 14 days before the import date.
 */
export function continueRefusal(
  run: { program: string; endDate: Date; completedWorkouts: number },
  otherEnds: readonly Date[],
  context: { programs: readonly KnownProgram[]; importDate: Date },
): ContinueRefusal | null {
  if (otherEnds.some((end) => end.getTime() > run.endDate.getTime())) return 'not-last';
  const program = continuableProgram(context.programs, run.program);
  if (!program) return 'unknown-program';
  if (run.completedWorkouts >= program.workoutCount) return 'finished';
  if ((toUTCMidnight(context.importDate).getTime() - run.endDate.getTime()) / DAY_MS > BREAK_DAYS) return 'stale';
  return null;
}

/** A stretch's rows as the sets `updateMaxes` reads, each with its session's workout number. */
function runRecords(stretch: HistoryStretch<LiftHistoryRecord>): LiftRecord[] {
  return stretch.sessions.flatMap((session) =>
    session.rows.map((r) => ({
      ...r,
      program: stretch.program,
      macrocycleNum: 1,
      workoutNum: r.workoutNum ?? session.workoutNum,
    })),
  );
}

type OfferRepos = Pick<
  RepositoryBundle,
  'macrocycle' | 'macrocycleDashboard' | 'liftRecord' | 'liftingProgramSpec' | 'trainingMax' | 'liftModification'
>;

/** The program's live macrocycle (its dashboard's), with its row and its sets, or null with none. */
async function liveMacrocycle(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'macrocycleDashboard' | 'liftRecord'>,
  program: string,
): Promise<AssignContinueOffer['live']> {
  const dashboard = await dashboardOrNull(repos, program);
  if (!dashboard) return null;
  const row = await repos.macrocycle.findByNumber(program, dashboard.macrocycleNum);
  // A macrocycle the API started before #1171 may have no row yet; it gets one, as a read gives it.
  const id = row?.id ?? (await macrocycleIdFor(repos, dashboard));
  if (!id) throw new Error(`The current macrocycle of ${program} has no row`);
  const sets = (await repos.liftRecord.getLiftRecords(program, dashboard.macrocycleNum)).length;
  return { id, macrocycleNum: dashboard.macrocycleNum, sets };
}

/**
 * `mode=assign`'s continue offer (decision 2): on the last stretch, when it's matched to a program
 * it may continue under ({@link continueRefusal}) and none of its rows is stored yet, so it forms a
 * macrocycle of its own. A stretch that joins a stored one, or is already imported, is history.
 */
export async function continueOffer(
  repos: OfferRepos,
  stretches: ReadonlyArray<HistoryStretch<LiftHistoryRecord>>,
  stored: readonly AssignStoredPlacement[],
  context: {
    importDate: Date;
    programs: readonly KnownProgram[];
    progression: ProgressionSettings;
    liftNames: ReadonlyMap<string, string>;
  },
): Promise<AssignContinueOffer | null> {
  const index = stretches.length - 1;
  const last = stretches[index];
  const placement = stored[index];
  if (!last || !placement || !last.matched) return null;
  if (placement.kind !== 'new' && placement.kind !== 'overlaps') return null;
  const refusal = continueRefusal(
    { program: last.program, endDate: last.endDate, completedWorkouts: last.completedWorkouts },
    stretches.slice(0, index).map((s) => s.endDate),
    context,
  );
  if (refusal) return null;

  const program = last.program;
  const records = runRecords(last);
  const computed = computeContinueMaxes(
    await repos.liftingProgramSpec.getProgramSpec(program),
    await repos.trainingMax.getTrainingMaxes(program),
    records,
    {
      program,
      liftOverrides: new Map(),
      modificationModes: (await modificationModesFor(repos, records)).modes,
      modificationMaxes: [],
      progression: context.progression,
    },
  );
  const maxes: AssignContinueMax[] = computed.map((m) => ({ ...m, name: context.liftNames.get(m.lift) ?? m.lift }));
  return { stretch: index, live: await liveMacrocycle(repos, program), maxes };
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

/** A continue the commit refused. The wizard returns to Assign for a fresh offer. */
export class ContinueRefusedException extends BadRequestException {
  constructor(
    readonly reason: ContinueRefusal | 'needs-agreement' | 'max-required' | 'unknown-lift' | 'bad-stretch',
    message: string,
  ) {
    super({ statusCode: 400, code: 'continue-refused', reason, message, error: 'Bad Request' });
  }
}

/** Reads the breakdown's `continue`, or undefined with none. This checks its shape only. */
export function parseContinue(value: unknown): ImportBreakdownContinue | undefined {
  if (value === undefined) return undefined;
  const bad = (what: string) => new BadRequestException(`breakdown.continue ${what}`);
  if (typeof value !== 'object' || value === null) throw bad('must be an object');
  const { stretch, endLive, maxes } = value as Record<string, unknown>;
  if (typeof stretch !== 'number' || !Number.isInteger(stretch) || stretch < 0) throw bad('must name a stretch by index');
  if (endLive !== undefined && typeof endLive !== 'string') throw bad('endLive must be a macrocycle id');
  if (!Array.isArray(maxes)) throw bad('must list the maxes to overwrite');
  const parsed = maxes.map((m: unknown) => {
    const entry = m as Record<string, unknown> | null;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.lift !== 'string' ||
      typeof entry.weight !== 'number' ||
      !Number.isFinite(entry.weight) ||
      entry.weight <= 0
    ) {
      throw bad('maxes must each have a lift and a weight above 0');
    }
    return { lift: entry.lift, weight: entry.weight };
  });
  return { stretch, ...(endLive !== undefined ? { endLive } : {}), maxes: parsed };
}

/** The stretch a breakdown continues, as the commit reads it. */
export interface ContinueRun {
  program: string;
  startDate: Date;
  endDate: Date;
  /** The workout numbers of its rows to create. */
  workoutNums: readonly number[];
  /** How the commit places it among the stored macrocycles. */
  placement: 'new' | 'overlaps' | 'joins' | 'already-imported';
}

/** What a checked continue will write. */
export interface ContinuePlan {
  program: string;
  /** The live macrocycle it ends, by id, with the agreement checked. */
  live: { id: string } | null;
  /** The maxes to write, under the lift spelling each is stored as. */
  maxes: TrainingMax[];
}

/**
 * Checks a breakdown's continue against the committed rows (decision 2): the run must still be one
 * that may continue ({@link continueRefusal}), with a row to create and no stored macrocycle to
 * join; the lifter must have agreed to end the program's live macrocycle, by its id; and each lift
 * the program plans with no max needs a value (decision 10). Runs before anything is written.
 */
export async function planContinue(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'macrocycleDashboard' | 'liftRecord' | 'liftingProgramSpec' | 'trainingMax'>,
  choice: ImportBreakdownContinue,
  run: ContinueRun | undefined,
  others: readonly Date[],
  context: { programs: readonly KnownProgram[]; importDate: Date },
): Promise<ContinuePlan> {
  if (!run) throw new ContinueRefusedException('bad-stretch', `Stretch ${choice.stretch + 1} isn't one of the breakdown's.`);
  if (run.placement === 'already-imported' || run.placement === 'joins') {
    throw new ContinueRefusedException(
      'already-stored',
      'The run to continue is already stored, so it stays history. Undo that import first to continue it.',
    );
  }
  const refusal = continueRefusal(
    { program: run.program, endDate: run.endDate, completedWorkouts: new Set(run.workoutNums).size },
    others,
    context,
  );
  if (refusal) throw new ContinueRefusedException(refusal, refusalMessage(refusal));

  const live = await liveMacrocycle(repos, run.program);
  if (live && choice.endLive !== live.id) {
    throw new ContinueRefusedException(
      'needs-agreement',
      `Continuing ends macrocycle ${live.macrocycleNum}, your current one in this program, which holds ${live.sets} set${live.sets === 1 ? '' : 's'}. Agree to end it to continue.`,
    );
  }

  const spec = await repos.liftingProgramSpec.getProgramSpec(run.program);
  const current = await repos.trainingMax.getTrainingMaxes(run.program);
  const planned = plannedLifts(spec);
  const chosen = new Map(choice.maxes.map((m) => [liftIdFor(m.lift), m.weight]));
  for (const lift of choice.maxes) {
    if (!planned.some((p) => liftIdFor(p) === liftIdFor(lift.lift))) {
      throw new ContinueRefusedException('unknown-lift', `${lift.lift} isn't a lift this program plans.`);
    }
  }
  const missing = planned.filter((lift) => !current.some((m) => liftIdFor(m.lift) === liftIdFor(lift)) && !chosen.has(liftIdFor(lift)));
  if (missing.length > 0) {
    throw new ContinueRefusedException(
      'max-required',
      `${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no training max. Choose the computed value or enter one.`,
    );
  }
  const maxes = planned.flatMap((lift): TrainingMax[] => {
    const weight = chosen.get(liftIdFor(lift));
    if (weight === undefined) return [];
    const stored = current.find((m) => liftIdFor(m.lift) === liftIdFor(lift));
    return [{ lift: stored?.lift ?? lift, weight, dateUpdated: toUTCMidnight(context.importDate) }];
  });
  return { program: run.program, live: live ? { id: live.id } : null, maxes };
}

function refusalMessage(reason: ContinueRefusal): string {
  switch (reason) {
    case 'not-last':
      return 'Only the run that ends last can continue as your current macrocycle.';
    case 'unknown-program':
      return "The run's program has no known length, so it can't continue as your current macrocycle.";
    case 'finished':
      return 'The run has no workouts left, so it stays history.';
    case 'stale':
      return `The run's last session is more than ${BREAK_DAYS} days old, so it stays history.`;
    case 'already-stored':
      return 'The run to continue is already stored, so it stays history.';
  }
}

/** The weekday a dashboard starts on, as the enum spells it. */
function weekdayOf(date: Date): Weekday {
  const day = Object.values(Weekday).find((v) => WEEKDAY_MAP[v.toLowerCase()] === date.getUTCDay());
  if (!day) throw new Error(`No Weekday mapping for UTC day index ${date.getUTCDay()}`);
  return day;
}

const ymd = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Makes the run, already written as its `live` macrocycle `runId`, the program's current one
 * (decision 2), after the breakdown's rows and maxes are written and its programs renumbered:
 *
 * - The live macrocycle it ends closes as starting the next one closes it (decision 1).
 * - The lifter's max choices are written (decision 10). Their pre-image joins `preImage`, keyed by
 *   lift as a split row's is, so undo restores them, or skips and flags one changed since. A lift a
 *   split row also wrote keeps the split's `before`, which is what the import found.
 * - The dashboard points at the run, its program becomes the active one, as `POST switch` makes it,
 *   and its remaining workouts are scheduled from the day after the import date. Completed
 *   workouts get no schedule.
 *
 * Returns what undo needs to put back.
 */
export async function applyContinue(
  repos: Pick<
    RepositoryBundle,
    | 'macrocycle'
    | 'macrocycleDashboard'
    | 'macrocycleScheduledWorkout'
    | 'liftRecord'
    | 'liftingProgramSpec'
    | 'trainingMax'
    | 'userSettings'
  >,
  plan: ContinuePlan,
  runId: string,
  context: { importDate: Date; preImage: ImportPreImage },
): Promise<ContinuedRun> {
  const { program } = plan;
  const run = await repos.macrocycle.findById(runId);
  if (!run) throw new Error(`The continued macrocycle ${runId} was not created`);
  const spec = await repos.liftingProgramSpec.getProgramSpec(program);

  // The live macrocycle ends, read by id: the renumbering may have moved it.
  let ended: ContinuedRun['ended'] = null;
  const before = await dashboardOrNull(repos, program);
  if (plan.live) {
    const live = await repos.macrocycle.findById(plan.live.id);
    if (!live) throw new Error(`The live macrocycle ${plan.live.id} is gone`);
    ended = { id: live.id, endDate: live.endDate ? ymd(live.endDate) : null, status: live.status };
    const range = (await repos.liftRecord.getMacrocycleDateRanges(program, live.macrocycleNum)).get(live.macrocycleNum);
    await repos.macrocycle.update(live.id, {
      endDate: range ? toUTCMidnight(range.last) : live.startDate,
      status: live.statusChosen
        ? live.status
        : closingStatus(await repos.liftRecord.getLoggedWorkoutNums(program, live.macrocycleNum), programWorkoutKeys(program, spec).length),
    });
  }

  if (plan.maxes.length > 0) {
    const existing = await repos.trainingMax.getTrainingMaxes(program);
    for (const [lift, entry] of Object.entries(buildTrainingMaxPreImage(plan.maxes, existing))) {
      const prior = context.preImage[lift];
      context.preImage[lift] = prior ? { ...prior, wrote: entry.wrote } : entry;
    }
    await repos.trainingMax.saveTrainingMaxes(program, plan.maxes);
  }

  const defaults = PROGRAM_DEFAULTS[program];
  if (!defaults) throw new Error(`No defaults for ${program}`);
  const dashboard: MacrocycleDashboard = {
    program,
    macrocycleUnit: before?.macrocycleUnit ?? defaults.macrocycleUnit,
    macrocycleNum: run.macrocycleNum,
    macrocycleDate: run.startDate,
    sheetName: `${program}_Cycle_${run.macrocycleNum}_${formatDateYYYYMMDD(run.startDate)}`,
    macrocycleStartWeekday: weekdayOf(run.startDate),
    programType: defaults.programType,
  };
  await repos.macrocycleDashboard.saveMacrocycleDashboard(dashboard);

  const settings = await repos.userSettings.getSettings();
  if (settings.activeProgram !== program) await repos.userSettings.upsertSettings({ activeProgram: program });

  const done = await repos.liftRecord.getLoggedWorkoutNums(program, run.macrocycleNum);
  const schedule = redatedScheduledWorkouts(
    program,
    spec,
    {
      rows: [],
      done,
      rescheduled: new Set(),
      workoutSchedule: settings.workoutSchedule,
      macrocycleDate: run.startDate,
      from: new Date(toUTCMidnight(context.importDate).getTime() + DAY_MS),
    },
    logger,
  );
  // With too few dates the run starts unscheduled, as a macrocycle start does (#1023).
  await repos.macrocycleScheduledWorkout.saveScheduledWorkouts(program, run.macrocycleNum, schedule?.rows ?? []);

  return {
    id: run.id,
    ended,
    dashboard: before
      ? {
          macrocycleUnit: before.macrocycleUnit,
          macrocycleDate: before.macrocycleDate.toISOString(),
          sheetName: before.sheetName,
          macrocycleStartWeekday: before.macrocycleStartWeekday,
          programType: before.programType ?? null,
        }
      : null,
    activeProgram: settings.activeProgram,
  };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

function undoRefused(message: string): ConflictException {
  return new ConflictException({ statusCode: 409, code: 'import-undo-refused', message, error: 'Conflict' });
}

/**
 * The continued run's macrocycle, while undo is safe (decision 2): the dashboard still points at
 * it. Once another macrocycle is current, or the run was deleted, undo is refused with the reason,
 * and nothing changes.
 */
export async function continuedRunToUndo(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'macrocycleDashboard'>,
  program: string,
  continued: ContinuedRun,
): Promise<MacrocycleRow> {
  const run = continued.id === '' ? null : await repos.macrocycle.findById(continued.id);
  if (!run) {
    throw undoRefused(
      "The macrocycle this import continued as current has been deleted, so the import can't be undone.",
    );
  }
  const dashboard = await dashboardOrNull(repos, program);
  if (dashboard?.macrocycleNum !== run.macrocycleNum) {
    throw undoRefused(
      `Macrocycle ${run.macrocycleNum}, which this import continued, is no longer your current one, so the import can't be undone.`,
    );
  }
  return run;
}

/**
 * Takes the continued run apart for undo (decision 2), before the batch's other keys are deleted.
 * Sets logged on it since the import aren't the batch's, so they stay, as non-cycle workouts
 * (decision 23), one per workout, with their dates, weights, reps, notes and modifications. Then its
 * number goes from every table: the imported sets, its schedule, overrides and focus state, the
 * dashboard pointing at it, and its row. Returns the batch's created keys left to delete, and how
 * many of its sets went with the run.
 */
export async function releaseContinuedRun(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'liftRecord' | 'importBatch'>,
  program: string,
  run: MacrocycleRow,
  createdKeys: readonly string[],
): Promise<{ keysLeft: string[]; removed: number; moved: number }> {
  const created = new Set(createdKeys);
  const records = await repos.liftRecord.getLiftRecords(program, run.macrocycleNum);
  const loggedSince = records.filter((r) => !created.has(liftRecordNaturalKey(r)));
  if (loggedSince.length > 0) {
    await repos.liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, await placeNonCycleRows(repos, loggedSince));
  }
  await repos.macrocycle.delete(program, [run.macrocycleNum]);
  // No other batch should hold keys on it, but one that did would delete another macrocycle's
  // sets once a renumbering moved one onto the number.
  await forgetBatchKeys(repos, program, { on: [run.macrocycleNum] });
  return {
    keysLeft: createdKeys.filter((k) => preImageKeyNumber(k) !== run.macrocycleNum),
    removed: records.length - loggedSince.length,
    moved: loggedSince.length,
  };
}

/**
 * Puts back what continuing changed besides sets and maxes (decision 2), once the run is gone and
 * the program renumbered: the ended macrocycle's end date and status, the dashboard pointing at it,
 * and the active program, unless the lifter has switched since. The ended macrocycle is read by
 * id, since an import of older history can have renumbered it. Returns flags for what it couldn't
 * put back.
 */
export async function restoreAroundContinuedRun(
  repos: Pick<RepositoryBundle, 'macrocycle' | 'macrocycleDashboard' | 'userSettings'>,
  program: string,
  continued: ContinuedRun,
): Promise<Array<{ key: string; reason: string }>> {
  const flagged: Array<{ key: string; reason: string }> = [];
  if (continued.ended) {
    const ended = await repos.macrocycle.findById(continued.ended.id);
    if (!ended) {
      flagged.push({ key: 'macrocycle', reason: 'the macrocycle the import ended no longer exists' });
    } else {
      await repos.macrocycle.update(ended.id, {
        endDate: continued.ended.endDate ? new Date(`${continued.ended.endDate}T00:00:00Z`) : null,
        status: continued.ended.status,
      });
      if (continued.dashboard) {
        await repos.macrocycleDashboard.saveMacrocycleDashboard({
          program,
          macrocycleUnit: continued.dashboard.macrocycleUnit,
          macrocycleNum: ended.macrocycleNum,
          macrocycleDate: new Date(continued.dashboard.macrocycleDate),
          sheetName: continued.dashboard.sheetName,
          macrocycleStartWeekday: continued.dashboard.macrocycleStartWeekday as Weekday,
          ...(continued.dashboard.programType !== null ? { programType: continued.dashboard.programType } : {}),
        });
      }
    }
  }
  const settings = await repos.userSettings.getSettings();
  if (settings.activeProgram === program && continued.activeProgram !== program) {
    await repos.userSettings.upsertSettings({ activeProgram: continued.activeProgram });
  }
  return flagged;
}
