/**
 * Which deployment this container serves (`staging` or `production`), read from
 * DEPLOYMENT_ENVIRONMENT. The deploy sets it on each web service through the
 * deploy-cloud-run-otel-sidecar action's `ingress_env`; locally it is unset, so
 * this falls back to `development` (#1448).
 *
 * Never NODE_ENV: `next build` replaces `process.env.NODE_ENV` with
 * `'production'` in every server bundle, so it names the build mode and reads
 * `production` on staging too. That is how /version told staging it was
 * production.
 *
 * Mirrors apps/api/src/otel.ts's resolveDeploymentEnvironment, which reads the
 * same variable, so web and api report the same environment for a deployment.
 * Keep the fallback and trim semantics the same in both.
 */
export function resolveDeploymentEnvironment(
  value: string | undefined = process.env.DEPLOYMENT_ENVIRONMENT,
): string {
  return value && value.trim() !== '' ? value.trim() : 'development';
}
