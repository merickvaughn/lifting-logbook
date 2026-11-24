import type { Attributes } from '@opentelemetry/api';

/** The label database's origin; `dsld-label-lookup.ts`'s base URL is on it (a test checks). */
export const DSLD_ORIGIN = 'https://api.ods.od.nih.gov';

/**
 * The outbound-HTTP span's URL for a label search carries the typed supplement name as `q`, which
 * stays out of traces (#1381). Every query value on that origin is replaced, keeping the keys, so a
 * parameter added later can't carry the name in either. Wired, with the Sheets redaction, as
 * instrumentation-undici's startSpanHook, whose attributes replace the instrumentation's own before
 * the span is started, so no span processor or sampler ever sees the name.
 */
export function redactDsldQueryAttributes(request: { origin: string; path: string }): Attributes {
  const at = request.path.indexOf('?');
  if (request.origin !== DSLD_ORIGIN || at === -1) return {};
  const query = request.path.slice(at).replace(/=[^&]*/g, '=:value');
  return { 'url.full': `${DSLD_ORIGIN}${request.path.slice(0, at)}${query}`, 'url.query': query };
}
