import type { Metadata } from 'next';
import { fetchMacrocycleDashboard, fetchProgramSpec } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { datedProgramPhases, type DatedPhase } from '@/lib/focusCalendar';
import { getPreferredUnit } from '@/lib/preferences';
import { buildPhaseTemplate, resolveProgramPlanMeta } from '@/lib/programPlan';
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
  const [dashboard, specs, unit] = await Promise.all([
    fetchMacrocycleDashboard(program),
    fetchProgramSpec(program),
    getPreferredUnit(),
  ]);

  let phases: DatedPhase[] = [];
  if (dashboard) {
    const template = buildPhaseTemplate(resolveProgramPlanMeta(program, specs));
    const days = buildWorkoutDays(specs, dashboard.macrocycleStartDate, program);
    phases = datedProgramPhases(template, days, workoutDateResolver(dashboard));
  }

  return <FocusCalendar phases={phases} unit={unit} />;
}
