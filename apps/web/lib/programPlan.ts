import type {
  MacrocycleDashboardResponse,
  LiftingProgramSpecResponse,
} from '@lifting-logbook/types';
import {
  PROGRAM_LENGTHS,
  baseSpecMesocycleWeeks,
  programLengthWeeks,
  type ProgramLengthMeta,
} from '@lifting-logbook/core';
import { workoutDateResolver, type WorkoutDay } from './workoutPlan';

// Phase rendering type. Built-in programs are autoregulated (Leangains, RPT) or a
// no-deload mesocycle (5/3/1), so their presets tag no deload/test weeks and
// buildPhaseTemplate currently only emits 'training'. 'deload'/'test' (and their
// plan.module.css styles) are retained for programs that define weekType-tagged
// weeks — not dead code until such a program exists. See issue #680.
export type PhaseType = 'training' | 'deload' | 'test';
export type PhaseStatus = 'completed' | 'in-progress' | 'upcoming';

/** Display labels for week types — never the raw enum value. */
export const WEEK_TYPE_LABELS: Record<PhaseType, string> = {
  training: 'Training',
  deload: 'Deload',
  test: 'Test week',
};

export const PHASE_STATUS_LABELS: Record<PhaseStatus, string> = {
  completed: 'Completed',
  'in-progress': 'In progress',
  upcoming: 'Upcoming',
};

export interface ProgramPhase {
  name: string;
  startWeek: number;
  endWeek: number;
  type: PhaseType;
  status: PhaseStatus;
}

export interface ProgramSummary {
  durationWeeks: number;
  frequency: number;
  exercises: string[];
  warmUpSets: number;
  workingSets: number;
}

/**
 * Resolves the canonical plan metadata for a program (issue #680). Registered
 * built-ins come from the core PROGRAM_LENGTHS registry; unregistered / custom
 * programs fall back to a single flat block of their own defined length,
 * preserving pre-#680 behavior.
 */
export function resolveProgramPlanMeta(
  program: string,
  specs: LiftingProgramSpecResponse[],
): ProgramLengthMeta {
  const registered = PROGRAM_LENGTHS[program];
  if (registered) return registered;
  const mesocycleWeeks = baseSpecMesocycleWeeks(specs);
  return { lengthWeeks: mesocycleWeeks, mesocycleWeeks, phaseStyle: 'repeating' };
}

export type PhaseTemplate = {
  name: string;
  startWeek: number;
  endWeek: number;
  type: PhaseType;
};

/**
 * Builds the phase template from a program's canonical metadata — never from a
 * fabricated week count (issue #680). Built-in programs carry no per-week
 * deload/test markers, so every phase is a training phase:
 *
 *  - 'repeating' (Leangains, RPT): a single flat "Training" span. Progression is
 *    autoregulated (AMRAP-driven via updateMaxes from actual lift records), not a
 *    scheduled weekly deload or a test week — so we never invent a "Test" phase.
 *  - 'mesocycle' (5/3/1): one "Mesocycle N" training phase per repeating block.
 */
export function buildPhaseTemplate(meta: ProgramLengthMeta): PhaseTemplate[] {
  const { lengthWeeks, mesocycleWeeks, phaseStyle } = meta;
  if (lengthWeeks <= 0) return [];

  if (phaseStyle === 'mesocycle' && mesocycleWeeks > 1) {
    const phases: PhaseTemplate[] = [];
    let mesocycle = 1;
    for (let startWeek = 1; startWeek <= lengthWeeks; startWeek += mesocycleWeeks) {
      const endWeek = Math.min(startWeek + mesocycleWeeks - 1, lengthWeeks);
      phases.push({ name: `Mesocycle ${mesocycle}`, startWeek, endWeek, type: 'training' });
      mesocycle += 1;
    }
    return phases;
  }

  return [{ name: 'Training', startWeek: 1, endWeek: lengthWeeks, type: 'training' }];
}

/** The parts of the Macrocycle Dashboard response a phase's status reads. */
export type PhaseDashboard = Pick<
  MacrocycleDashboardResponse,
  'weeks' | 'dateOverrides' | 'completedWorkoutNums' | 'skippedWorkoutNums'
>;

/**
 * Each phase of the Macrocycle Plan with its status, read from the macrocycle's
 * workouts (`days`, from `buildWorkoutDays`) the way the Macrocycle Dashboard
 * grid reads them:
 * - a phase is completed once every workout in it is logged or skipped;
 * - else it is in progress once a workout in it is logged or skipped, or dated
 *   today or earlier, each dated by {@link workoutDateResolver}. Logging a workout
 *   early does not move its date, so a phase trained ahead of its dates has to
 *   count its logged workouts to read as started;
 * - else it is upcoming.
 *
 * `dashboard.weeks` is empty without a schedule, which is the default for a new
 * user, so status cannot come from its week summaries (issue #1036). This reads
 * the same in both modes: with a schedule, a week summary is completed exactly
 * when its workouts are logged or skipped, and lists them on the dates the
 * resolver gives.
 */
export function deriveProgramPhases(
  days: readonly Pick<WorkoutDay, 'workoutNum' | 'week' | 'date'>[],
  dashboard: PhaseDashboard,
  today: string,
  meta: ProgramLengthMeta,
): ProgramPhase[] {
  const dateOf = workoutDateResolver(dashboard);
  const completed = new Set(dashboard.completedWorkoutNums);
  const skipped = new Set(dashboard.skippedWorkoutNums);
  const done = (d: Pick<WorkoutDay, 'workoutNum'>) =>
    completed.has(d.workoutNum) || skipped.has(d.workoutNum);
  return buildPhaseTemplate(meta).map((p) => {
    const phaseDays = days.filter((d) => d.week >= p.startWeek && d.week <= p.endWeek);
    const status: PhaseStatus =
      phaseDays.length > 0 && phaseDays.every(done)
        ? 'completed'
        : phaseDays.some((d) => done(d) || dateOf(d) <= today)
          ? 'in-progress'
          : 'upcoming';
    return { ...p, status };
  });
}

/**
 * The Macrocycle Plan's estimated completion date: the latest date among the macrocycle's
 * workouts (`days`, from `buildWorkoutDays`), each dated as the Macrocycle Dashboard
 * dates it ({@link workoutDateResolver}).
 *
 * This is one definition for both modes (issue #1023):
 * - a schedule sets the pace, so 5-3-1's 24 days on Mon/Wed/Fri end in calendar
 *   week 8, not 12;
 * - a rescheduled workout moves the estimate whether or not there is a schedule.
 *
 * A program with no workouts completes on its start date.
 */
export function estimateCompletionDate(
  days: readonly Pick<WorkoutDay, 'workoutNum' | 'date'>[],
  dashboard: Pick<MacrocycleDashboardResponse, 'macrocycleStartDate' | 'weeks' | 'dateOverrides'>,
): string {
  const dateOf = workoutDateResolver(dashboard);
  return days.reduce((last, day) => {
    const date = dateOf(day);
    return date > last ? date : last;
  }, dashboard.macrocycleStartDate);
}

export function deriveProgramSummary(
  specs: LiftingProgramSpecResponse[],
  program: string,
): ProgramSummary {
  // Duration is the canonical program length (single source of truth, issue #680),
  // not Math.max(...specs.week) — the stored spec is only a repeating block, so
  // Leangains would otherwise report "1 total week" against its advertised 12.
  const durationWeeks = programLengthWeeks(program, specs);

  const week1Specs = specs.filter((s) => s.week === 1);
  const frequency = new Set(week1Specs.map((s) => s.offset)).size;

  const exercises = [...new Set(specs.map((s) => s.lift))];

  const firstSpec = week1Specs[0];
  const warmUpSets = firstSpec?.warmUpPct?.split(',').filter(Boolean).length ?? 0;
  const workingSets = firstSpec?.sets ?? 0;

  return { durationWeeks, frequency, exercises, warmUpSets, workingSets };
}
