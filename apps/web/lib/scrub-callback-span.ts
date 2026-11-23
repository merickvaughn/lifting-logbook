// Removes the query string from the trace spans of the Google callback request (#1433, ADR-047
// decision 26): it holds the single-use authorization `code` and `state`. Wired as a span
// processor ahead of the exporter in instrumentation.ts. The attributes are scrubbed as the span
// ends, because Next sets some of them after the span starts.

export const CALLBACK_PATH = '/settings/data/google-sheet/callback';

const URL_ATTRIBUTES = ['url.full', 'http.url', 'http.target', 'url.path'] as const;
const QUERY_ATTRIBUTES = ['url.query'] as const;

type Attributes = Record<string, unknown>;

function isCallback(attributes: Attributes): boolean {
  return [...URL_ATTRIBUTES, 'next.route', 'http.route'].some((key) => {
    const value = attributes[key];
    return typeof value === 'string' && value.includes(CALLBACK_PATH);
  });
}

/** Strips the query from the callback span's attributes, in place. Other spans are left alone. */
export function scrubCallbackAttributes(attributes: Attributes): void {
  if (!isCallback(attributes)) return;
  for (const key of URL_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string') attributes[key] = value.split(/[?#]/)[0];
  }
  for (const key of QUERY_ATTRIBUTES) delete attributes[key];
}

/**
 * A span processor (structurally `SpanProcessor` from @opentelemetry/sdk-trace-base, which this
 * app doesn't depend on directly). `attributes` is typed read-only but is the object the exporter
 * reads, and it's mutable until the span is exported.
 */
export const callbackSpanScrubber = {
  onStart() {},
  onEnd(span: { attributes: Attributes }) {
    scrubCallbackAttributes(span.attributes);
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
