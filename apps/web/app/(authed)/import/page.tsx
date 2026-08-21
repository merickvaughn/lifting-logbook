import type { Metadata } from 'next';
import type { CustomLiftResponse, CustomProgramSummaryResponse } from '@lifting-logbook/types';
import { fetchCustomLifts, fetchCustomPrograms } from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import { ImportWizard } from './ImportWizard';

export const metadata: Metadata = {
  title: 'Import — Lifting Logbook',
  description: 'Import any CSV — lift history, training maxes, strength goals, or a program.',
};

export default async function ImportPage() {
  // The three fetches below have no data dependency on each other — run them
  // concurrently rather than serially, so a slow/failing one doesn't add its
  // full latency to the other two's (#911 review, second pass; /import is
  // already a heavy on-demand-compiled route per this project's CLAUDE.md).
  // Promise.allSettled (not Promise.all) so one rejecting doesn't abort the
  // others — each source keeps its own independent fallback-to-empty-list
  // behavior below, matching the original sequential version exactly.
  const [programsResult, customLiftsResult, unit] = await Promise.all([
    fetchCustomPrograms().then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    ),
    fetchCustomLifts().then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    ),
    getPreferredUnit(),
  ]);

  // The program-picker on the Source step lists the user's custom programs (the
  // realistic import target for a migrating user; program-spec import requires a
  // custom program anyway). On fetch failure we render with an empty list so the
  // wizard shows its "create a program first" guidance rather than crashing; the
  // failure is logged so the upstream fetch problem stays observable.
  let programs: CustomProgramSummaryResponse[];
  if (programsResult.status === 'fulfilled') {
    programs = programsResult.value;
  } else {
    console.error('ImportPage: custom programs fetch failed, rendering empty picker', programsResult.reason);
    programs = [];
  }

  // Feeds the REVIEW step's ambiguous-row remap datalist (#911). On fetch failure,
  // render with an empty list rather than crashing — the wizard still works, it
  // just can't offer existing custom lifts as remap targets until a reload.
  let customLifts: CustomLiftResponse[];
  if (customLiftsResult.status === 'fulfilled') {
    customLifts = customLiftsResult.value;
  } else {
    console.error('ImportPage: custom lifts fetch failed, rendering empty list', customLiftsResult.reason);
    customLifts = [];
  }

  return <ImportWizard programs={programs} customLifts={customLifts} unit={unit} />;
}
