import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { UserWorkoutSchedule } from '@lifting-logbook/types';
import {
  CycleDashboard,
  LiftingProgramSpec,
  distributeWorkouts,
  formatDateYYYYMMDD,
  MaxReductionFlag,
  programWorkoutKeys,
  TrainingMax,
  TrainingMaxHistoryEntry,
  updateCycle,
  updateMaxes,
  weekTypeForDate,
  WEEKDAY_MAP,
  Weekday,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports';
import { ScheduledWorkout } from '../ports/ICycleScheduledWorkoutRepository';
import { ProgramNotFoundError } from '../ports/errors';
import { StartNewCycleDto } from './start-new-cycle.dto';

type CycleRepos = Pick<
  RepositoryBundle,
  | 'cycleDashboard'
  | 'cycleScheduledWorkout'
  | 'liftingProgramSpec'
  | 'liftRecord'
  | 'trainingMax'
  | 'trainingMaxHistory'
  | 'userSettings'
>;

/**
 * Static metadata required to bootstrap cycle 1 for each supported program.
 * ADD AN ENTRY HERE when a new program is made available in onboarding —
 * omitting it causes 400 Bad Request for every first-time user of that program.
 *
 * ALSO add a spec entry to PRESET_BASE_SPECS in packages/core/src/presets/index.ts.
 * Without a spec, getProgramSpec() returns [] for that program. Users with a
 * workout schedule will have saveScheduledDates silently skipped (degraded but
 * safe), and the cycle view will render with no program spec data.
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
export const PROGRAM_DEFAULTS: Record<string, { cycleUnit: string; programType: string }> = {
  '5-3-1': { cycleUnit: 'week', programType: '5-3-1' },
  'rpt': { cycleUnit: 'week', programType: 'rpt' },
  'starting-strength': { cycleUnit: 'week', programType: 'starting-strength' },
  'stronglifts': { cycleUnit: 'week', programType: 'stronglifts' },
  'ppl': { cycleUnit: 'week', programType: 'ppl' },
  'upper-lower': { cycleUnit: 'week', programType: 'upper-lower' },
  '531': { cycleUnit: 'week', programType: '531' },
  '531-bbb': { cycleUnit: 'week', programType: '531-bbb' },
  '531-forever': { cycleUnit: 'week', programType: '531-forever' },
  'leangains': { cycleUnit: 'week', programType: 'leangains' },
  'conjugate': { cycleUnit: 'week', programType: 'conjugate' },
  'smolov': { cycleUnit: 'week', programType: 'smolov' },
  'juggernaut': { cycleUnit: 'week', programType: 'juggernaut' },
  'creeping-death-2': { cycleUnit: 'week', programType: 'creeping-death-2' },
};

/**
 * Dates every workout day of the program from the user's schedule: one scheduled
 * workout per program day, in the program's own order (issue #1023, ADR-037).
 *
 * Workout N is the program's N-th `(week, offset)` day ({@link programWorkoutKeys},
 * the numbering the Cycle Dashboard and the workout endpoint read) and gets the
 * schedule's N-th date. So the schedule sets only the pace: a schedule training more
 * or fewer days a week than the program, or a different number each week, stretches
 * or compresses the calendar instead of re-numbering the program. Each row's
 * `weekNum` is its day's program week.
 *
 * The program is tiled to its canonical length first: repeating programs (Leangains,
 * RPT) store a 1-week block but run 8–12 weeks (issue #680). An empty spec has no
 * days, so nothing is scheduled.
 */
async function saveScheduledDates(
  repos: Pick<CycleRepos, 'cycleScheduledWorkout'>,
  program: string,
  cycleNum: number,
  cycleDate: Date,
  programSpec: LiftingProgramSpec[],
  workoutSchedule: UserWorkoutSchedule,
): Promise<void> {
  const days = programWorkoutKeys(program, programSpec);
  if (days.length === 0) return;
  const dates = distributeWorkouts(days.length, workoutSchedule, cycleDate).flatMap(
    (week) => week.workouts,
  );
  // distributeWorkouts dates every workout, or none for a schedule with no days.
  if (dates.length === 0) return;
  if (dates.length !== days.length) {
    throw new Error(`distributeWorkouts dated ${dates.length} of ${days.length} workouts`);
  }

  const workouts: ScheduledWorkout[] = days.flatMap((day, i) => {
    const scheduledDate = dates[i];
    return scheduledDate ? [{ workoutNum: i + 1, weekNum: day.week, scheduledDate }] : [];
  });
  await repos.cycleScheduledWorkout.saveScheduledWorkouts(program, cycleNum, workouts);
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

export interface CycleGenerationResult {
  dashboard: CycleDashboard;
  programSpec: LiftingProgramSpec[];
}

@Injectable()
export class CycleGenerationService {
  async startNewCycle(
    repos: CycleRepos,
    program: string,
    dto: StartNewCycleDto = {},
  ): Promise<CycleGenerationResult> {
    const dashboard = await repos.cycleDashboard.getCycleDashboard(program);
    const sourceCycleNum = dto.fromCycleNum ?? dashboard.cycleNum;

    const [programSpec, trainingMaxes, liftRecords] = await Promise.all([
      repos.liftingProgramSpec.getProgramSpec(program),
      repos.trainingMax.getTrainingMaxes(program),
      repos.liftRecord.getLiftRecords(program, sourceCycleNum),
    ]);

    let prevDashboard = dashboard;
    if (dto.fromCycleNum !== undefined) {
      if (liftRecords.length === 0) {
        throw new BadRequestException(
          `No lift records found for cycle ${dto.fromCycleNum}`,
        );
      }
      const minDate = liftRecords.reduce(
        (min, r) => (r.date < min ? r.date : min),
        liftRecords[0]!.date,
      );
      prevDashboard = { ...dashboard, cycleNum: dto.fromCycleNum, cycleDate: minDate };
    }

    const cycleOverrides = dto.cycleDate
      ? { overrideDate: new Date(dto.cycleDate) }
      : {};

    const newCycle = updateCycle(prevDashboard, cycleOverrides);
    // Deliberate: flagged reductions are silently blocked here — they are not surfaced
    // to the caller when advancing a cycle. Use recalculateMaxes to review flagged reductions.
    const { maxes: newMaxes } = updateMaxes(programSpec, trainingMaxes, liftRecords);

    // Write order: maxes → scheduled dates → dashboard. If dashboard write fails,
    // cycleNum hasn't advanced in the dashboard so a retry is safe. Scheduled date
    // rows use replace-all semantics and are idempotent across retries.
    await repos.trainingMax.saveTrainingMaxes(program, newMaxes);
    const settings = await repos.userSettings.getSettings();
    if (settings.workoutSchedule) {
      await saveScheduledDates(repos, program, newCycle.cycleNum, newCycle.cycleDate, programSpec, settings.workoutSchedule);
    }
    await repos.cycleDashboard.saveCycleDashboard(newCycle);

    // Source reflects the week type of the cycle being closed (the previous
    // dashboard), not the new cycle being opened — hence `dashboard.cycleDate`,
    // not `newCycle.cycleDate`.
    const source = weekTypeForDate(dashboard.cycleDate, programSpec) === 'test' ? 'test' : 'program';
    const historyEntries = buildHistoryEntries(trainingMaxes, newMaxes, newCycle.cycleDate, source);
    if (historyEntries.length > 0) {
      await repos.trainingMaxHistory.appendHistoryEntries(program, historyEntries);
    }

    return { dashboard: newCycle, programSpec };
  }

  async initializeFirstCycle(
    repos: Pick<CycleRepos, 'cycleDashboard' | 'cycleScheduledWorkout' | 'liftingProgramSpec' | 'userSettings'>,
    program: string,
    dto: { cycleDate?: string } = {},
  ): Promise<CycleGenerationResult> {
    // Guard: fail fast if a cycle already exists for this user+program
    try {
      await repos.cycleDashboard.getCycleDashboard(program);
      throw new ConflictException(`A cycle for "${program}" already exists.`);
    } catch (e) {
      if (!(e instanceof ProgramNotFoundError)) throw e;
      // ProgramNotFoundError is expected — no cycle exists yet, proceed
    }

    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const defaults = PROGRAM_DEFAULTS[program] ??
      (UUID_PATTERN.test(program) ? { cycleUnit: 'week', programType: 'custom' } : null);
    if (!defaults) {
      throw new BadRequestException(`Unknown program: "${program}"`);
    }

    const cycleDate = dto.cycleDate ? new Date(dto.cycleDate) : new Date();
    // Search enum values (PascalCase) rather than WEEKDAY_MAP keys (lowercase)
    // to ensure the stored value matches the Weekday enum contract.
    const weekdayName = Object.values(Weekday).find(
      (v) => WEEKDAY_MAP[v.toLowerCase()] === cycleDate.getUTCDay(),
    );
    if (!weekdayName) {
      throw new Error(`No Weekday mapping for UTC day index ${cycleDate.getUTCDay()}`);
    }

    const dashboard: CycleDashboard = {
      program,
      cycleUnit: defaults.cycleUnit,
      cycleNum: 1,
      cycleDate,
      sheetName: `${program}_Cycle_1_${formatDateYYYYMMDD(cycleDate)}`,
      cycleStartWeekday: weekdayName,
      programType: defaults.programType,
    };

    const [settings, programSpec] = await Promise.all([
      repos.userSettings.getSettings(),
      repos.liftingProgramSpec.getProgramSpec(program),
    ]);
    // A program with no seeded spec has no days, so saveScheduledDates dates none.
    if (settings.workoutSchedule) {
      await saveScheduledDates(repos, program, dashboard.cycleNum, dashboard.cycleDate, programSpec, settings.workoutSchedule);
    }
    await repos.cycleDashboard.saveCycleDashboard(dashboard);
    return { dashboard, programSpec };
  }

  /**
   * Deletes the current cycle for a program and every row scoped to it: the
   * CycleDashboard, all LiftRecord rows across every cycle number, all TrainingMax
   * rows, all TrainingMaxHistory entries, and any CycleScheduledWorkout rows for the
   * deleted cycle. Deliberately leaves UserSettings.activeProgram untouched — that
   * field is independent of cycle existence and is used by switchProgram's routing.
   *
   * getCycleDashboard(program) is called first for two reasons: it supplies the
   * cycleNum needed to scope the CycleScheduledWorkout clear, and it throws
   * ProgramNotFoundError (-> 404) when nothing exists, giving a free "nothing to
   * delete" response with no new error-handling code — mirrors the guard
   * initializeFirstCycle uses to detect "no cycle yet".
   *
   * The five deletes run sequentially, not concurrently: repos.forUser() binds
   * them all to the single interactive-transaction Prisma client RlsInterceptor
   * holds for this request, which serializes queries on one connection — a
   * Promise.all here would not parallelize anything and can throw a "queries
   * cannot run concurrently" error against the real Prisma adapter (the in-memory
   * adapter has no such constraint, so this would pass there and fail in
   * production). Atomicity across all five is already guaranteed by that same
   * request transaction, independent of the order below.
   */
  async deleteCurrentCycle(
    repos: Pick<
      CycleRepos,
      'cycleDashboard' | 'cycleScheduledWorkout' | 'liftRecord' | 'trainingMax' | 'trainingMaxHistory'
    >,
    program: string,
  ): Promise<void> {
    const dashboard = await repos.cycleDashboard.getCycleDashboard(program);

    await repos.liftRecord.deleteAllLiftRecords(program);
    await repos.trainingMaxHistory.deleteAllHistory(program);
    await repos.trainingMax.deleteAllTrainingMaxes(program);
    await repos.cycleScheduledWorkout.saveScheduledWorkouts(program, dashboard.cycleNum, []);
    await repos.cycleDashboard.deleteCycleDashboard(program);
  }

  async recalculateMaxes(
    repos: CycleRepos,
    program: string,
  ): Promise<{ maxes: TrainingMax[]; flagged: MaxReductionFlag[] }> {
    const dashboard = await repos.cycleDashboard.getCycleDashboard(program);
    const [programSpec, trainingMaxes, liftRecords] = await Promise.all([
      repos.liftingProgramSpec.getProgramSpec(program),
      repos.trainingMax.getTrainingMaxes(program),
      repos.liftRecord.getLiftRecords(program, dashboard.cycleNum),
    ]);

    const result = updateMaxes(programSpec, trainingMaxes, liftRecords);
    await repos.trainingMax.saveTrainingMaxes(program, result.maxes);

    const historyEntries = buildHistoryEntries(trainingMaxes, result.maxes, dashboard.cycleDate, 'program');
    if (historyEntries.length > 0) {
      await repos.trainingMaxHistory.appendHistoryEntries(program, historyEntries);
    }

    return result;
  }
}
