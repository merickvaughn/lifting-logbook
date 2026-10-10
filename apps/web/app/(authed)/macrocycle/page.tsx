import { redirect } from 'next/navigation';
import { fetchMacrocycleDashboard } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import type { MacrocycleDashboardResponse } from '@lifting-logbook/types';

export default async function MacrocyclePage() {
  const program = await getActiveProgram();

  let dashboard: MacrocycleDashboardResponse | null;
  try {
    dashboard = await fetchMacrocycleDashboard(program);
  } catch {
    // API unavailable or auth token expired — redirect to onboarding rather than
    // crashing the server component and leaving the URL stuck at /macrocycle.
    redirect('/onboarding');
  }

  if (!dashboard) redirect('/onboarding');
  redirect(`/macrocycle/${dashboard.macrocycleNum}`);
}
