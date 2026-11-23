import { registerOTel } from '@vercel/otel';
import { buildOtelOptions } from './lib/otel-options';

// Tag web telemetry with the deployment environment so it is distinguishable
// from production in the shared free-tier Grafana Cloud stack, mirroring the API
// (apps/api/src/otel.ts). NODE_ENV is set per environment by the Helm values and
// the Cloud Run service spec; locally it falls back to `development`. See #487.
//
// Intentional duplication: this mirrors `resolveDeploymentEnvironment` in
// apps/api/src/otel.ts (the canonical, unit-tested copy). The two live in
// separate workspaces; sharing would mean a new cross-package dependency for a
// three-line env read. If you change the fallback/trim semantics here, change it
// there too (and apps/api/src/otel.spec.ts) so staging/prod labelling stays
// consistent across both services.
function resolveDeploymentEnvironment(): string {
  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv && nodeEnv.trim() !== '' ? nodeEnv.trim() : 'development';
}

export function register() {
  registerOTel(buildOtelOptions(resolveDeploymentEnvironment()));
}
