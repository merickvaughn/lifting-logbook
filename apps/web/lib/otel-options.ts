import type { Configuration } from '@vercel/otel';
import { callbackSpanScrubber } from './scrub-callback-span';

/**
 * What instrumentation.ts hands to `registerOTel`. Built here so a test can check the span
 * scrubber is registered, and ahead of the exporter's processor (`'auto'`): the callback's query
 * must be gone before that processor sees the span (#1433, ADR-047 decision 26).
 */
export function buildOtelOptions(deploymentEnvironment: string): Configuration {
  return {
    serviceName: 'lifting-logbook-web',
    attributes: {
      'deployment.environment.name': deploymentEnvironment,
    },
    spanProcessors: [callbackSpanScrubber, 'auto'],
  };
}
