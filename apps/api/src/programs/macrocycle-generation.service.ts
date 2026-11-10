import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { UserWorkoutSchedule } from '@lifting-logbook/types';
import {
  MacrocycleDashboard,
  LiftingProgramSpec,
  distributeWorkouts,
  formatDateYYYYMMDD,
  MaxReductionFlag,
  programWorkoutKeys,
  TrainingMax,
  TrainingMaxHistoryEntry,
  updateMacrocycle,
  toUTCMidnight,
  updateMaxes,
  weekTypeForDate,
  WEEKDAY_MAP,
  Weekday,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports';
import { ScheduledWorkout } from '../ports/IMacrocycleScheduledWorkoutRepository';
import { ProgramNotFoundError } from '../ports/errors';
import { StartNewMacrocycleDto } from './start-new-macrocycle.dto';
import {
  assertMacrocycleWritable,
  closingStatus,
  ensureCurrentRow,
  nextMacrocycleNumber,
} from './macrocycle-history.util';

type MacrocycleRepos = Pick<
  RepositoryBundle,
  | 'macrocycle'
  | 'macrocycleDashboard'
  | 'macrocycleScheduledWorkout'
  | 'liftingProgramSpec'
  | 'liftRecord'
  | 'trainingMax'
  | 'trainingMaxHistory'
  | 'userSettings'
  | 'workoutLiftOverride'
  | 'workoutDateOverride'
>;

/**
 * Static metadata required to bootstrap macrocycle 1 for each supported program.
 * ADD AN ENTRY HERE when a new program is made available in onboarding —
 * omitting it causes 400 Bad Request for every first-time user of that program.
 *
 * ALSO add a spec entry to PRESET_BASE_SPECS in packages/core/src/presets/index.ts.
 * Without a spec, getProgramSpec() returns [] for that program. Users with a
 * workout schedule will have saveScheduledDates silently skipped (degraded but
 * safe), and the macrocycle view will render with no program spec data.
 * ALSO add a canonical length to PROGRAM_LENGTHS (packages/core/src/presets/
 * programLengths.ts), or the program's schedule and plan collapse to its 1-block
 * length instead of the advertised duration (issue #680).
 * These three registries must stay in sync. The PRESET_BASE_SPECS ⊆ PROGRAM_DEFAULTS
 * direction is enforced by program-defaults.registry-sync.spec.ts (issue #747); the
 * reciprocal PRESET_BASE_SPECS ⊆ PROGRAM_LENGTHS guard lives in core's
 * programLengths.test.ts.
 *
 * Exported for that guard test.
 */
export const PROGRAM_DEFAULTS: Record<string, { macrocycleUnit: string; programType: string }> = {
  '5-3-1': { macrocycleUnit: 'week', programType: '5-3-1' },
  'rpt': { macrocycleUnit: 'week', programType: 'rpt' },
  'starting-strength': { macrocycleUnit: 'week', programType: 'starting-strength' },
  'stronglifts': { macrocycleUnit: 'week', programType: 'stronglifts' },
  'ppl': { macrocycleUnit: 'week', programType: 'ppl' },
  'upper-lower': { macrocycleUnit: 'week', programType: 'upper-lower' },
  '531': { macrocycleUnit: 'week', programType: '531' },
  '531-bbb': { macrocycleUnit: 'week', programType: '531-bbb' },
  '531-forever': { macrocycleUnit: 'week', programType: '531-forever' },
  'leangains': { macrocycleUnit: 'week', programType: 'leangains' },
  'conjugate': { macrocycleUnit: 'week', programType: 'conjugate' },
  'smolov': { macrocycleUnit: 'week', programType: 'smolov' },
  'juggernaut': { macrocycleUnit: 'week', programType: 'juggernaut' },
  'creeping-death-2': { macrocycleUnit: 'week', programType: 'creeping-death-2' },
};

/**
 * Replaces a new macrocycle's scheduled rows: one per program day, dated by the user's
 * schedule in the program's own order (issue #1023, ADR-037).
 *
 * Workout N is the program's N-th `(week, offset)` day ({@link programWorkoutKeys},
 * the numbering the Macrocycle Dashboard and the workout endpoint read) and gets the
 * schedule's N-th date. So the schedule sets only the pace: a schedule training more
 * or fewer days a week than the program, or a different number each week, stretches
 * or compresses the calendar instead of re-numbering the program. Each row's
 * `weekNum` is its day's program week. The program is tiled to its canonical length
 * first: repeating programs (Leangains, RPT) store a 1-week block but run 8–12 weeks
 * (issue #680).
 *
 * With no schedule, or nothing to date, the rows are cleared rather than left alone.
 * `deleteCurrentMacrocycle` clears only the current macrocycle's rows, so a macrocycle number
 * reused after a delete, or via `fromMacrocycleNum`, would otherwise inherit dates a
 * previous macrocycle of that number was given.
 */
async function saveScheduledDates(
  repos: Pick<MacrocycleRepos, 'macrocycleScheduledWorkout'>,
  program: string,
  macrocycleNum: number,
  macrocycleDate: Date,
  programSpec: LiftingProgramSpec[],
  workoutSchedule: UserWorkoutSchedule | null,
  logger: Logger,
): Promise<ScheduledWorkout[]> {
  const workouts = workoutSchedule
    ? datesForProgramDays(program, macrocycleNum, macrocycleDate, programSpec, workoutSchedule, logger)
    : [];
  await repos.macrocycleScheduledWorkout.saveScheduledWorkouts(program, macrocycleNum, workouts);
  return workouts;
}

function datesForProgramDays(
  program: string,
  macrocycleNum: number,
  macrocycleDate: Date,
  programSpec: LiftingProgramSpec[],
  workoutSchedule: UserWorkoutSchedule,
  logger: Logger,
): ScheduledWorkout[] {
  const days = programWorkoutKeys(program, programSpec);
  if (days.length === 0) return [];
  const dates = distributeWorkouts(days.length, workoutSchedule, macrocycleDate).flatMap(
    (week) => week.workouts,
  );
  // A valid schedule has at least one day, and distributeWorkouts then dates every
  // workout. Any other count, none included, breaks its contract. Numbering doesn't
  // depend on the schedule (ADR-037), so no rows costs only the dates: the macrocycle
  // runs unscheduled instead of failing to start for every scheduled user.
  if (dates.length !== days.length) {
    logger.error(
      { program, macrocycleNum, programDays: days.length, dated: dates.length, schedule: workoutSchedule },
      'distributeWorkouts dated the wrong number of workouts; the macrocycle is left unscheduled (#1023)',
    );
    return [];
  }
  return days.flatMap((day, i) => {
    const scheduledDate = dates[i];
    return scheduledDate ? [{ workoutNum: i + 1, weekNum: day.week, scheduledDate }] : [];
  });
}

function round2dp(w: number): number {
  return Math.round(w * 100) / 100;
}

/** Exported for direct unit testing of the change-detection comparison precision. */
export function buildHistoryEntries(
  prevMaxes: TrainingMax[],
  newMaxes: TrainingMax[],
  date: Date,
  source: 'test' | 'program',
): Omit<TrainingMaxHistoryEntry, 'id'>[] {
  const prevMap = new Map(prevMaxes.map((m) => [m.lift, round2dp(m.weight)]));
  return newMaxes
    .filter((m) => prevMap.get(m.lift) !== round2dp(m.weight))
    .map((m) => ({
      lift: m.lift,
      weight: m.weight,
      reps: 1,
      date,
      isPR: false,
      source,
      goalMet: false,
    }));
}

export interface MacrocycleGenerationResult {
  dashboard: MacrocycleDashboard;
  programSpec: LiftingProgramSpec[];
  /** The rows just saved for the new macrocycle, so its current week type needs no re-read. */
  scheduledWorkouts: ScheduledWorkout[];
}

@Injectable()
export class MacrocycleGenerationService {
  private readonly logger = new Logger(MacrocycleGenerationService.name);

  async startNewMacrocycle(
    repos: MacrocycleRepos,
    program: string,
    dto: StartNewMacrocycleDto = {},
  ): Promise<MacrocycleGenerationResult> {
    const dashboard = await repos.macrocycleDashboard.getMacrocycleDashboard(program);
    const sourceMacrocycleNum = dto.fromMacrocycleNum ?? dashboard.macrocycleNum;
    const closingRow = await ensureCurrentRow(repos, dashboard);
    // Imported history can't feed the training maxes, and a number with no macrocycle has no
    // records to feed them (proposal decision 2).
    if (dto.fromMacrocycleNum !== undefined) {
      await assertMacrocycleWritable(repos, program, dto.fromMacrocycleNum);
    }
    // One past every stored number, not the source + 1, so `fromMacrocycleNum` can't reuse a
    // number and a new macrocycle can't land on imported history (ADR-042).
    const newMacrocycleNum = await nextMacrocycleNumber(repos, program, dashboard);

    const [
      programSpec,
      trainingMaxes,
      liftRecords,
      liftOverrides,
      closingScheduled,
      closingDateOverrides,
      closingWorkoutNums,
      closingRange,
    ] = await Promise.all([
      repos.liftingProgramSpec.getProgramSpec(program),
      repos.trainingMax.getTrainingMaxes(program),
      repos.liftRecord.getLiftRecords(program, sourceMacrocycleNum),
      repos.workoutLiftOverride.getOverridesForMacrocycle(program, sourceMacrocycleNum),
      repos.macrocycleScheduledWorkout.getScheduledWorkouts(program, dashboard.macrocycleNum),
      repos.workoutDateOverride.getOverridesForMacrocycle(program, dashboard.macrocycleNum),
      repos.liftRecord.getLoggedWorkoutNums(program, dashboard.macrocycleNum),
      repos.liftRecord.getMacrocycleDateRanges(program, dashboard.macrocycleNum),
    ]);

    let prevDashboard = dashboard;
    if (dto.fromMacrocycleNum !== undefined) {
      if (liftRecords.length === 0) {
        throw new BadRequestException(
          `No lift records found for macrocycle ${dto.fromMacrocycleNum}`,
        );
      }
      const minDate = liftRecords.reduce(
        (min, r) => (r.date < min ? r.date : min),
        liftRecords[0]!.date,
      );
      prevDashboard = { ...dashboard, macrocycleNum: dto.fromMacrocycleNum, macrocycleDate: minDate };
    }

    const newMacrocycle = updateMacrocycle(prevDashboard, {
      macrocycleNum: newMacrocycleNum,
      ...(dto.macrocycleDate && { overrideDate: new Date(dto.macrocycleDate) }),
    });
    // Deliberate: flagged reductions are silently blocked here — they are not surfaced
    // to the caller when advancing a macrocycle. Use recalculateMaxes to review flagged reductions.
    const { maxes: newMaxes } = updateMaxes(programSpec, trainingMaxes, liftRecords, { program, liftOverrides });

    // The new row goes first: a concurrent request that took this number makes it throw a 409
    // before anything else is written (the request transaction rolls back the rest anyway).
    await repos.macrocycle.create({
      program,
      macrocycleNum: newMacrocycle.macrocycleNum,
      startDate: toUTCMidnight(newMacrocycle.macrocycleDate),
      status: 'in-progress',
      origin: 'live',
    });
    // The closing macrocycle ends on its last session, or its start with none (decision 1). A
    // status the lifter chose stays.
    await repos.macrocycle.close(program, dashboard.macrocycleNum, {
      endDate: closingRange.get(dashboard.macrocycleNum)?.last ?? closingRow.startDate,
      status: closingRow.statusChosen
        ? closingRow.status
        : closingStatus(closingWorkoutNums, programWorkoutKeys(program, programSpec).length),
    });

    // Write order: maxes → scheduled dates → dashboard. If dashboard write fails,
    // macrocycleNum hasn't advanced in the dashboard so a retry is safe. Scheduled date
    // rows use replace-all semantics and are idempotent across retries.
    await repos.trainingMax.saveTrainingMaxes(program, newMaxes);
    const settings = await repos.userSettings.getSettings();
    const scheduledWorkouts = await saveScheduledDates(repos, program, newMacrocycle.macrocycleNum, newMacrocycle.macrocycleDate, programSpec, settings.workoutSchedule, this.logger);
    await repos.macrocycleDashboard.saveMacrocycleDashboard(newMacrocycle);

    // Source reflects the week type of the macrocycle being closed (the previous
    // dashboard), not the new macrocycle being opened — hence `dashboard.macrocycleDate`,
    // not `newMacrocycle.macrocycleDate`.
    const closingWeekType = weekTypeForDate(program, dashboard.macrocycleDate, programSpec, {
      scheduled: closingScheduled,
      overrides: closingDateOverrides,
    });
    const source = closingWeekType === 'test' ? 'test' : 'program';
    const historyEntries = buildHistoryEntries(trainingMaxes, newMaxes, newMacrocycle.macrocycleDate, source);
    if (historyEntries.length > 0) {
      await repos.trainingMaxHistory.appendHistoryEntries(program, historyEntries);
    }

    return { dashboard: newMacrocycle, programSpec, scheduledWorkouts };
  }

  async initializeFirstMacrocycle(
    repos: Pick<MacrocycleRepos, 'macrocycle' | 'macrocycleDashboard' | 'macrocycleScheduledWorkout' | 'liftingProgramSpec' | 'userSettings'>,
    program: string,
    dto: { macrocycleDate?: string } = {},
  ): Promise<MacrocycleGenerationResult> {
    // Guard: fail fast if a macrocycle already exists for this user+program
    try {
      await repos.macrocycleDashboard.getMacrocycleDashboard(program);
      throw new ConflictException(`A macrocycle for "${program}" already exists.`);
    } catch (e) {
      if (!(e instanceof ProgramNotFoundError)) throw e;
      // ProgramNotFoundError is expected — no macrocycle exists yet, proceed
    }

    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const defaults = PROGRAM_DEFAULTS[program] ??
      (UUID_PATTERN.test(program) ? { macrocycleUnit: 'week', programType: 'custom' } : null);
    if (!defaults) {
      throw new BadRequestException(`Unknown program: "${program}"`);
    }

    const macrocycleDate = dto.macrocycleDate ? new Date(dto.macrocycleDate) : new Date();
    // Search enum values (PascalCase) rather than WEEKDAY_MAP keys (lowercase)
    // to ensure the stored value matches the Weekday enum contract.
    const weekdayName = Object.values(Weekday).find(
      (v) => WEEKDAY_MAP[v.toLowerCase()] === macrocycleDate.getUTCDay(),
    );
    if (!weekdayName) {
      throw new Error(`No Weekday mapping for UTC day index ${macrocycleDate.getUTCDay()}`);
    }

    // 1 for a program with no history; after imported history, the number past it (ADR-042).
    const macrocycleNum = await nextMacrocycleNumber(repos, program, null);
    const dashboard: MacrocycleDashboard = {
      program,
      macrocycleUnit: defaults.macrocycleUnit,
      macrocycleNum,
      macrocycleDate,
      sheetName: `${program}_Cycle_${macrocycleNum}_${formatDateYYYYMMDD(macrocycleDate)}`,
      macrocycleStartWeekday: weekdayName,
      programType: defaults.programType,
    };

    const [settings, programSpec] = await Promise.all([
      repos.userSettings.getSettings(),
      repos.liftingProgramSpec.getProgramSpec(program),
    ]);
    await repos.macrocycle.create({
      program,
      macrocycleNum,
      startDate: toUTCMidnight(macrocycleDate),
      status: 'in-progress',
      origin: 'live',
    });
    // Without a schedule, or a seeded spec, this clears any rows a deleted macrocycle left.
    const scheduledWorkouts = await saveScheduledDates(repos, program, dashboard.macrocycleNum, dashboard.macrocycleDate, programSpec, settings.workoutSchedule, this.logger);
    await repos.macrocycleDashboard.saveMacrocycleDashboard(dashboard);
    return { dashboard, programSpec, scheduledWorkouts };
  }

  /**
   * Deletes the current macrocycle for a program and every row scoped to it: the
   * MacrocycleDashboard, all TrainingMax rows, all TrainingMaxHistory entries, and for every
   * macrocycle number except imported ones, its LiftRecord, MacrocycleScheduledWorkout,
   * workout date, skip and lift override, saved focus choice (FocusDayState) and Macrocycle
   * rows. Imported macrocycles are history and stay with their records (ADR-042). Deliberately leaves
   * UserSettings.activeProgram untouched — that field is independent of macrocycle
   * existence and is used by switchProgram's routing. Focus blocks and the focus budget
   * stay too: they are dated plans that outlive a macrocycle, like strength goals.
   *
   * The per-workout rows go for every number but the imported ones, not just the deleted
   * one, because re-initializing takes the first number past what's left: an override left
   * on a legacy number would otherwise reappear on a later macrocycle given it (issue #1084).
   *
   * getMacrocycleDashboard(program) is called first because it throws
   * ProgramNotFoundError (-> 404) when nothing exists, giving a free "nothing to
   * delete" response with no new error-handling code — mirrors the guard
   * initializeFirstMacrocycle uses to detect "no macrocycle yet".
   *
   * The deletes run sequentially, not concurrently: repos.forUser() binds
   * them all to the single interactive-transaction Prisma client RlsInterceptor
   * holds for this request, which serializes queries on one connection — a
   * Promise.all here would not parallelize anything and can throw a "queries
   * cannot run concurrently" error against the real Prisma adapter (the in-memory
   * adapter has no such constraint, so this would pass there and fail in
   * production). Atomicity across all of them is already guaranteed by that same
   * request transaction, independent of the order below.
   */
  async deleteCurrentMacrocycle(
    repos: Pick<
      RepositoryBundle,
      | 'macrocycle'
      | 'macrocycleDashboard'
      | 'macrocycleScheduledWorkout'
      | 'liftRecord'
      | 'trainingMax'
      | 'trainingMaxHistory'
      | 'workoutDateOverride'
      | 'workoutSkipOverride'
      | 'workoutLiftOverride'
      | 'focus'
    >,
    program: string,
  ): Promise<void> {
    await repos.macrocycleDashboard.getMacrocycleDashboard(program);
    // Imported history survives a delete with its records (proposal decision 2); `live` and
    // `legacy` macrocycles go, from every table that holds a number.
    const keep = (await repos.macrocycle.list(program))
      .filter((m) => m.origin === 'imported')
      .map((m) => m.macrocycleNum);

    await repos.liftRecord.deleteAllLiftRecords(program, keep);
    await repos.trainingMaxHistory.deleteAllHistory(program);
    await repos.trainingMax.deleteAllTrainingMaxes(program);
    await repos.macrocycleScheduledWorkout.deleteAllScheduledWorkouts(program, keep);
    await repos.workoutDateOverride.deleteAllOverrides(program, keep);
    await repos.workoutSkipOverride.deleteAllSkips(program, keep);
    await repos.workoutLiftOverride.deleteAllOverrides(program, keep);
    await repos.focus.deleteAllDayStates(program, keep);
    await repos.macrocycle.deleteAllExcept(program, keep);
    await repos.macrocycleDashboard.deleteMacrocycleDashboard(program);
  }

  async recalculateMaxes(
    repos: MacrocycleRepos,
    program: string,
  ): Promise<{ maxes: TrainingMax[]; flagged: MaxReductionFlag[] }> {
    const dashboard = await repos.macrocycleDashboard.getMacrocycleDashboard(program);
    const [programSpec, trainingMaxes, liftRecords, liftOverrides] = await Promise.all([
      repos.liftingProgramSpec.getProgramSpec(program),
      repos.trainingMax.getTrainingMaxes(program),
      repos.liftRecord.getLiftRecords(program, dashboard.macrocycleNum),
      repos.workoutLiftOverride.getOverridesForMacrocycle(program, dashboard.macrocycleNum),
    ]);

    const result = updateMaxes(programSpec, trainingMaxes, liftRecords, { program, liftOverrides });
    await repos.trainingMax.saveTrainingMaxes(program, result.maxes);

    const historyEntries = buildHistoryEntries(trainingMaxes, result.maxes, dashboard.macrocycleDate, 'program');
    if (historyEntries.length > 0) {
      await repos.trainingMaxHistory.appendHistoryEntries(program, historyEntries);
    }

    return result;
  }
}
