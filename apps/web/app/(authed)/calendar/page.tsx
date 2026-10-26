import type { Metadata } from 'next';
import { DEFAULT_WEIGHT_UNIT } from '@lifting-logbook/types';
import { fetchMacrocycleDashboard, fetchProgramSpec } from '@/lib/api';
import { getActiveProgram, getUserSettings } from '@/lib/active-program';
import { datedProgramPhases, type DatedPhase } from '@/lib/focusCalendar';
import { deriveProgramPhases, resolveProgramPlanMeta } from '@/lib/programPlan';
import { buildWorkoutDays, workoutDateResolver } from '@/lib/workoutPlan';
import FocusCalendar from './FocusCalendar';

export const metadata: Metadata = {
  title: 'Calendar — Lifting Logbook',
  description: 'The program and focus blocks on one timeline.',
};

/**
 * The calendar (`/calendar`, #1059): the program's phases and the user's focus blocks on
 * one Gantt. The program row is dated here from the current macrocycle's workouts; focus
 * blocks are fetched in the browser, which knows the user's calendar day (ADR-039 §5).
 */
export default async function CalendarPage() {
  const program = await getActiveProgram();
  const [dashboard, specs, settings] = await Promise.all([
    fetchMacrocycleDashboard(program),
    fetchProgramSpec(program),
    getUserSettings(),
  ]);

  let phases: DatedPhase[] = [];
  if (dashboard) {
    // Only each phase's name, type and weeks are used; its status, which needs `today`,
    // is not shown here.
    const today = new Date().toISOString().slice(0, 10);
    const template = deriveProgramPhases(dashboard.weeks, today, resolveProgramPlanMeta(program, specs));
    const days = buildWorkoutDays(specs, dashboard.macrocycleStartDate, program);
    phases = datedProgramPhases(template, days, workoutDateResolver(dashboard));
  }

  return (
    <FocusCalendar phases={phases} unit={settings.unit ?? DEFAULT_WEIGHT_UNIT} />
  );
}
