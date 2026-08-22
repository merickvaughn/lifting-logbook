import type { Metadata } from 'next';
import { DEFAULT_WEIGHT_UNIT } from '@lifting-logbook/types';
import type { CustomLiftResponse, CustomProgramSummaryResponse, WeightUnit } from '@lifting-logbook/types';
import { fetchCustomLifts, fetchCustomPrograms } from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import { ImportWizard } from './ImportWizard';

export const metadata: Metadata = {
  title: 'Import — Lifting Logbook',
  description: 'Import any CSV — lift history, training maxes, strength goals, or a program.',
};

export default async function ImportPage() {
  // The three fetches below have no data dependency on each other — run them
  // concurrently via the real Promise.allSettled (not Promise.all, and not
  // Promise.all with hand-rolled reflection wrappers, which round 2 of this
  // PR's own review used here and left getPreferredUnit() as the one
  // unwrapped entry — its rejection would abort the whole Promise.all and
  // crash this Server Component, contradicting this comment's own claim that
  // one rejecting can never abort the others; issue #911 review, third
  // pass). getPreferredUnit() is documented never to throw (see
  // lib/preferences.ts), so this is a defense-in-depth fallback rather than a
  // live bug fix — but the point of Promise.allSettled is not depending on
  // that staying true. Each source keeps its own independent fallback below.
  const [programsResult, customLiftsResult, unitResult] = await Promise.allSettled([
    fetchCustomPrograms(),
    fetchCustomLifts(),
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

  // getPreferredUnit() never actually rejects (it swallows its own upstream
  // failure internally) — this branch is unreachable today, kept only so this
  // page's resilience doesn't silently regress if that contract ever changes.
  let unit: WeightUnit;
  if (unitResult.status === 'fulfilled') {
    unit = unitResult.value;
  } else {
    console.error('ImportPage: preferred-unit fetch failed, defaulting', unitResult.reason);
    unit = DEFAULT_WEIGHT_UNIT;
  }

  return <ImportWizard programs={programs} customLifts={customLifts} unit={unit} />;
}
