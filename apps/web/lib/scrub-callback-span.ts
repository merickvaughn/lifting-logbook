// Removes the query string from the trace spans of the Google callback request (#1433, ADR-047
// decision 26): it holds the single-use authorization `code` and `state`. Wired as a span
// processor ahead of the exporter (lib/otel-options.ts). The attributes are scrubbed as the span
// ends, because Next sets some of them after the span starts.
//
// The same query reaches /sign-in when the lifter's session has ended: the middleware redirects to
// `/sign-in?redirect_url=<the callback URL, query included>`. A span whose URL mentions the
// callback path anywhere, raw or percent-encoded, is scrubbed too.

export const CALLBACK_PATH = '/settings/data/google-sheet/callback';

const URL_ATTRIBUTES = ['url.full', 'http.url', 'http.target', 'url.path'] as const;
const QUERY_ATTRIBUTES = ['url.query'] as const;
const ROUTE_ATTRIBUTES = ['next.route', 'http.route'] as const;

// `google-sheet/callback`, with the slash plain or encoded once or twice.
const CALLBACK_MENTION = /google-sheet(?:\/|%2f|%252f)callback/i;

type Attributes = Record<string, unknown>;

function mentionsCallback(attributes: Attributes): boolean {
  return [...URL_ATTRIBUTES, ...QUERY_ATTRIBUTES, ...ROUTE_ATTRIBUTES].some((key) => {
    const value = attributes[key];
    return typeof value === 'string' && CALLBACK_MENTION.test(value);
  });
}

/** Strips the query from the span's URL attributes, in place, if the span concerns the callback. */
export function scrubCallbackAttributes(attributes: Attributes): void {
  if (!mentionsCallback(attributes)) return;
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
