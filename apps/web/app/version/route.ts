import { NextResponse } from 'next/server';
import { resolveDeploymentEnvironment } from '../../lib/deployment-environment';

// Deployment identity probe (#671): reports the git commit this container is
// running, mirroring apps/api's GET /version. GIT_SHA is baked into the image
// at Docker build time (apps/web/Dockerfile's runner stage) — a property of
// the build, not the environment, so unlike the runtime-injected config in
// lib/public-config.ts (ADR-028) it's safe to bake in rather than inject at
// deploy time: it never differs per destination for a given build. A missing
// GIT_SHA only degrades observability, not functionality, so this degrades to
// 'unknown' rather than throwing.
//
// Deliberately mirrors /livez, not /api/healthz: this is a pure,
// unauthenticated probe excluded from clerkMiddleware entirely (see the
// `version` exclusion in apps/web/middleware.ts), unlike /api/healthz which
// deliberately runs through Clerk to test its own init.
//
// force-dynamic prevents Next from prerendering or edge-caching the
// response so the probe always reflects the running container, not a frozen
// build artifact.
export const dynamic = 'force-dynamic';

// `environment` comes from DEPLOYMENT_ENVIRONMENT, never NODE_ENV, which a
// Next production build pins to 'production' on staging too (#1448).
export async function GET() {
  // Truthy check (not ??): the Dockerfile's ARG has a default of 'unknown',
  // but a manual `docker build` without --build-arg GIT_SHA=... still yields
  // an empty string, not undefined — `??` would let that through unchanged.
  return NextResponse.json({
    gitSha: process.env.GIT_SHA || 'unknown',
    environment: resolveDeploymentEnvironment(),
  });
}
