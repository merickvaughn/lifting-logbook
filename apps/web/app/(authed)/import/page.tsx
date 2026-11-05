import type { Metadata } from 'next';
import { DEFAULT_WEIGHT_UNIT } from '@lifting-logbook/types';
import type { CustomLiftResponse, CustomProgramSummaryResponse, WeightUnit } from '@lifting-logbook/types';
import { getUserSettings } from '@/lib/active-program';
import { fetchCustomLifts, fetchCustomPrograms } from '@/lib/api';
import { getPreferredUnit } from '@/lib/preferences';
import { PROGRAMS } from '@/lib/programs';
import { ImportWizard } from './ImportWizard';
import type { ImportTarget } from './steps';

export const metadata: Metadata = {
  title: 'Import — Lifting Logbook',
  description: 'Import any CSV — lift history, training maxes, strength goals, or a program.',
};

// Custom programs are addressed by UUID and built-in templates by slug, as on the API.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user's custom programs, plus the template they're on if they're on one. The
 * active program comes first because the wizard preselects the first entry, and
 * importing should default to the program the rest of the app is reading (#1115).
 *
 * The template's name falls back to its slug because the catalog doesn't list every
 * slug the API serves ('5-3-1' is a preset, while the catalog's entry is '531').
 */
function importTargets(
  customPrograms: CustomProgramSummaryResponse[],
  activeProgram: string | null,
): ImportTarget[] {
  const targets: ImportTarget[] = [...customPrograms];
  if (activeProgram && !UUID_PATTERN.test(activeProgram)) {
    const name = PROGRAMS.find((p) => p.id === activeProgram)?.name ?? activeProgram;
    targets.push({ id: activeProgram, name, isTemplate: true });
  }
  return targets.sort((a, b) => Number(b.id === activeProgram) - Number(a.id === activeProgram));
}

export default async function ImportPage() {
  // The fetches below have no data dependency on each other — run them
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
  const [programsResult, customLiftsResult, unitResult, settingsResult] = await Promise.allSettled([
    fetchCustomPrograms(),
    fetchCustomLifts(),
    getPreferredUnit(),
    getUserSettings(),
  ]);

  // On fetch failure we render with an empty list so the wizard shows its "choose
  // a program first" guidance rather than crashing; the failure is logged so the
  // upstream fetch problem stays observable.
  let customPrograms: CustomProgramSummaryResponse[];
  if (programsResult.status === 'fulfilled') {
    customPrograms = programsResult.value;
  } else {
    console.error('ImportPage: custom programs fetch failed, rendering empty picker', programsResult.reason);
    customPrograms = [];
  }

  // Reads settings directly rather than through getActiveProgram(), which falls
  // back to a default program: this choice decides where data gets written, so an
  // account with no active program, or a failed fetch, must not import into a
  // template the user never picked.
  let activeProgram: string | null;
  if (settingsResult.status === 'fulfilled') {
    activeProgram = settingsResult.value.activeProgram;
  } else {
    console.error('ImportPage: user settings fetch failed, omitting active program', settingsResult.reason);
    activeProgram = null;
  }
  const programs = importTargets(customPrograms, activeProgram);

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
