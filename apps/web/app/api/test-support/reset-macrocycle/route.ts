import { NextResponse } from 'next/server';
import { ApiClientError } from '@lifting-logbook/api-client';
import { deleteCurrentMacrocycle } from '@/lib/api';

// Test-support endpoint for the staging Playwright suite (issue #647). Deletes the
// requesting user's current macrocycle (and its dependent rows) so the onboarding write-
// path test can run repeatedly against the same account without hitting the
// "macrocycle already exists" short-circuit in switchProgram
// (apps/api/src/programs/switch-program.controller.ts).
//
// Uses the SAME auth mechanism as the real "Start My Program" flow (lib/api.ts's
// X-Clerk-Authorization strategy) rather than a special-cased path — see
// docs/adr/ADR-023-staging-integration-test-design.md's "Alternatives Considered"
// for why the two more "obvious" shortcuts (server getToken()+forward, client
// getToken()+direct-fetch) are both already known to be flaky against this
// specific staging Clerk instance; this route intentionally does not reinvent
// either.
//
// Not linked from any UI; not documented as a public API. It is still a real,
// destructive, auth-gated-but-not-environment-gated endpoint, so it is
// deliberately inert wherever CLERK_PUBLISHABLE_KEY is a live (pk_live_) key —
// per docs/deploy.md, staging uses pk_test_ and production uses pk_live_, and
// apps/web is built once and promoted to both (ADR-028), so this runtime check
// is the only way to keep the route staging-only without a new deploy-time env
// var. "Not linked from any UI" alone is not a control; this is.
export async function DELETE(request: Request) {
  if (process.env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_live_')) {
    return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const program = searchParams.get('program');
  // Fail fast on misuse rather than silently defaulting to a program the caller
  // may not have meant — the one caller (staging.spec.ts) always passes this
  // explicitly, so a missing param means the route was called wrong.
  if (!program) {
    return NextResponse.json({ ok: false, error: 'Missing required "program" query param' }, { status: 400 });
  }

  try {
    await deleteCurrentMacrocycle(program);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(`[reset-macrocycle] failed for program "${program}":`, e);
    // Relay the upstream status (e.g. 401/403 from an expired/invalid Clerk
    // session) rather than flattening every failure to 500 — the caller (the
    // Playwright test's cleanup hooks) and anyone debugging a red staging run
    // both need to tell "auth is broken" apart from "the delete itself failed".
    const status = e instanceof ApiClientError ? e.status : 500;
    return NextResponse.json({ ok: false, error: String(e) }, { status });
  }
}
