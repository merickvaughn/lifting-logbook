import type {
  CycleDashboardResponse,
  CycleWeekSummary,
  LiftingProgramSpecResponse,
} from '@lifting-logbook/types';
import {
  PROGRAM_LENGTHS,
  baseSpecBlockWeeks,
  programLengthWeeks,
  type ProgramLengthMeta,
} from '@lifting-logbook/core';
import { workoutDateResolver, type WorkoutDay } from './workoutPlan';

// Phase rendering type. Built-in programs are autoregulated (Leangains, RPT) or a
// no-deload wave (5/3/1), so their presets tag no deload/test weeks and
// buildPhaseTemplate currently only emits 'training'. 'deload'/'test' (and their
// plan.module.css styles) are retained for programs that define weekType-tagged
// weeks — not dead code until such a program exists. See issue #680.
export type PhaseType = 'training' | 'deload' | 'test';
export type PhaseStatus = 'completed' | 'in-progress' | 'upcoming';

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
  const blockWeeks = baseSpecBlockWeeks(specs);
  return { lengthWeeks: blockWeeks, blockWeeks, phaseStyle: 'repeating' };
}

type PhaseTemplate = {
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
 *  - 'wave' (5/3/1): one "Wave N" training phase per repeating block.
 */
function buildPhaseTemplate(meta: ProgramLengthMeta): PhaseTemplate[] {
  const { lengthWeeks, blockWeeks, phaseStyle } = meta;
  if (lengthWeeks <= 0) return [];

  if (phaseStyle === 'wave' && blockWeeks > 1) {
    const phases: PhaseTemplate[] = [];
    let wave = 1;
    for (let startWeek = 1; startWeek <= lengthWeeks; startWeek += blockWeeks) {
      const endWeek = Math.min(startWeek + blockWeeks - 1, lengthWeeks);
      phases.push({ name: `Wave ${wave}`, startWeek, endWeek, type: 'training' });
      wave += 1;
    }
    return phases;
  }

  return [{ name: 'Training', startWeek: 1, endWeek: lengthWeeks, type: 'training' }];
}

function phaseStatus(
  phase: { startWeek: number; endWeek: number },
  weekMap: Map<number, CycleWeekSummary>,
  today: string,
): PhaseStatus {
  const weeks = Array.from(
    { length: phase.endWeek - phase.startWeek + 1 },
    (_, i) => phase.startWeek + i,
  );
  const summaries = weeks.map((w) => weekMap.get(w));
  // Every week in the phase must exist and be completed. With a schedule, `weeks`
  // lists every program week (#1023). Without one it is empty, so every phase reads
  // upcoming for the whole cycle (#1036).
  if (summaries.length > 0 && summaries.every((s) => s?.completed)) return 'completed';
  const hasStarted = summaries.some((s) =>
    s?.workouts.some((w) => w.date <= today),
  );
  return hasStarted ? 'in-progress' : 'upcoming';
}

export function deriveProgramPhases(
  weeks: CycleWeekSummary[],
  today: string,
  meta: ProgramLengthMeta,
): ProgramPhase[] {
  const weekMap = new Map(weeks.map((w) => [w.week, w]));
  return buildPhaseTemplate(meta).map((p) => ({
    ...p,
    status: phaseStatus(p, weekMap, today),
  }));
}

/**
 * The Program Plan's estimated completion date: the latest date among the cycle's
 * workouts (`days`, from `buildWorkoutDays`), each dated as the Cycle Dashboard
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
  dashboard: Pick<CycleDashboardResponse, 'cycleStartDate' | 'weeks' | 'dateOverrides'>,
): string {
  const dateOf = workoutDateResolver(dashboard);
  return days.reduce((last, day) => {
    const date = dateOf(day);
    return date > last ? date : last;
  }, dashboard.cycleStartDate);
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
