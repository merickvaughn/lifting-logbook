'use server';

import { redirect } from 'next/navigation';
import { switchProgram, updateTrainingMaxes } from '@/lib/api';
import { PROGRAMS } from '@/lib/programs';

export type CreateFirstMacrocycleResult = { ok: false; error: string };

export async function createFirstMacrocycle(
  programId: string,
  maxes: { lift: string; trainingMax: number }[] = [],
): Promise<CreateFirstMacrocycleResult | never> {
  const allowed = PROGRAMS.filter((p) => p.available).map((p) => p.id);
  if (!allowed.includes(programId)) {
    return { ok: false, error: 'That program is not yet available.' };
  }
  let macrocycleNum = 1;
  try {
    // switchProgram both ensures a macrocycle exists for programId (creating one if this is a
    // genuine first-time setup) AND sets it as the user's activeProgram in one call — the
    // dashboard page resolves its program via getActiveProgram(), not the URL, so without
    // this the redirect below would 404 even though the macrocycle was created successfully
    // (issue #650).
    ({ macrocycleNum } = await switchProgram(programId));
    // Persist the confirmed training maxes exactly as shown on the Confirm step.
    // The caller (OnboardingFlow) already resolved each lift to its final training
    // max — deriving it at 90% of the 1RM for the estimate/test/manual methods, or
    // taking the entered value as-is for the "enter training maxes" method — so this
    // action persists the value verbatim and does no further adjustment. Runs after
    // switchProgram so it overrides any maxes the macrocycle seeded. The PATCH endpoint
    // merges and appends unknown lifts, so any catalog or custom lift name is accepted.
    //
    // Best-effort by design: switchProgram has already created (or found) the macrocycle, so a
    // max-persistence failure must not strand the user on the program-selection
    // step with a macrocycle that exists but is unreachable from this flow. Training
    // maxes are editable later in settings, so we log and proceed to the macrocycle
    // rather than failing the whole flow.
    //
    // Error-fallback coverage (docs/standards/error-fallback-test-coverage.md,
    // option c): the catch below intentionally swallows the PATCH error after
    // logging it server-side; the success path (maxes reach updateTrainingMaxes)
    // is asserted in OnboardingFlow.test.tsx, and the swallow only changes
    // post-macrocycle-creation behavior, which has no client-visible data to assert.
    if (maxes.length > 0) {
      try {
        await updateTrainingMaxes(programId, {
          maxes: maxes.map((m) => ({
            lift: m.lift,
            weight: m.trainingMax,
            unit: 'lbs',
          })),
        });
      } catch (maxErr) {
        console.error(
          `createFirstMacrocycle: macrocycle initialized for "${programId}" but persisting training maxes failed; continuing to /macrocycle/${macrocycleNum}`,
          maxErr,
        );
      }
    }
  } catch (e) {
    // redirect() must be called outside the try block (see below). Any error
    // reaching here is a genuine failure — log it so it appears in Loki under
    // the web-app service stream for diagnosis without a code change.
    console.error(`[createFirstMacrocycle] failed for program "${programId}":`, e);
    return { ok: false, error: 'Failed to start your program. Please try again.' };
  }
  // redirect() throws NEXT_REDIRECT internally. Calling it outside the try block
  // lets Next.js propagate it natively — no need for the internal isRedirectError
  // guard, which is fragile across major Next.js versions. Uses the macrocycleNum
  // switchProgram returned rather than a hardcoded 1 — almost always 1 for a genuine
  // first-time setup, but correct too if a macrocycle already existed (see switchProgram).
  redirect(`/macrocycle/${macrocycleNum}`);
}
