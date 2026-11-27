import { registerOTel } from '@vercel/otel';
import { buildOtelOptions } from './lib/otel-options';
import { resolveDeploymentEnvironment } from './lib/deployment-environment';

// Tag web telemetry with the deployment environment so it is distinguishable
// from production in the shared free-tier Grafana Cloud stack, mirroring the API
// (apps/api/src/otel.ts). See #487, and #1448 for why this is not NODE_ENV.

export function register() {
  registerOTel(buildOtelOptions(resolveDeploymentEnvironment()));
}
