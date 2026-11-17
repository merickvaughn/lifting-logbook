# ADR-020: Tail-Based Sampling Policy — Errors Always, Slow Always, 20% Clean

**Status:** Accepted
**Date:** 2026-05-09
**Closes:** [#210](https://github.com/merickvaughn/lifting-logbook/issues/210)
**Supersedes (partially):** [ADR-018](ADR-018-observability-stack.md) § Sampling

---

## Context

[ADR-018](ADR-018-observability-stack.md) locked in head-based 100% sampling at project start
because no production traffic existed to inform a more nuanced policy. The negative consequences
section of that ADR explicitly noted:

> "Head-based 100% sampling will not scale to high-traffic production. Tracked in
> [#210](https://github.com/merickvaughn/lifting-logbook/issues/210); revisit when sustained ingest
> crosses 1,000 spans/minute (24h avg) or monthly Grafana Cloud trace cost exceeds $25."

Issue #210 specifies a proactive approach: implement the sampling policy before the triggers are
crossed so it is live from the first day of real traffic, rather than scrambling to add it
after ingest costs begin accumulating.

The OTel Collector image already deployed
(`otel/opentelemetry-collector-contrib:0.104.0`) includes the `tail_sampling` processor with
no upgrade required.

---

## Decision

Replace head-based 100% sampling with **tail-based sampling at the Collector** using three
policies evaluated in order, where a trace is kept if any policy matches:

| Policy | Type | Condition | Action |
|---|---|---|---|
| `errors` | `status_code` | Any span in the trace has `STATUS_CODE_ERROR` | Always keep |
| `slow_traces` | `latency` | Total trace duration ≥ 1 000 ms | Always keep |
| `probabilistic` | `probabilistic` | All remaining traces | Keep `OTEL_TAIL_SAMPLE_RATE`% |

**Decision wait:** Driven by `OTEL_DECISION_WAIT` env var. 10 s in staging and production
(driven by `decisionWait: "10s"` in `infra/kubernetes/charts/otel-collector/values.yaml`) —
sufficient to see the full HTTP request/response span chain across `apps/web` → `apps/api` →
Postgres in normal operating conditions.

**Default sampling rate:** 20% for staging and production (driven by `tailSampleRate: "20"` in
`infra/kubernetes/charts/otel-collector/values.yaml`).

**Local dev overrides** (`docker-compose.yml`):
- `OTEL_TAIL_SAMPLE_RATE: "100"` — keep every trace; no debugging friction from sampling.
- `OTEL_DECISION_WAIT: "2s"` — shorter buffer so spans appear in Grafana Tempo within ~2 s
  rather than waiting the full 10 s decision window.

---

## Rationale for tail-based over head-based ratio

Head-based ratio sampling (e.g., `parentbased_traceidratio` in the SDK) makes the
keep/drop decision at trace start, before any spans are recorded. This means:
- An error that occurred on the 5th span of a sampled-out trace is permanently discarded.
- A 10-second database query in a dropped trace is invisible.

Tail-based sampling at the Collector buffers the full trace and decides after all spans
arrive. The `errors` and `slow_traces` policies guarantee that every actionable trace is kept
regardless of the clean-trace sampling rate.

**Why at the Collector, not the SDK:** The OTel SDK's built-in samplers are all head-based.
Moving sampling to the Collector is the canonical approach for tail-based decisions and requires
no changes to application code. The Collector's `tail_sampling` processor is production-proven
and is the upstream recommendation for this use case.

---

## Alternatives Considered

### Head-based ratio (SDK `parentbased_traceidratio`)

Set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and
`OTEL_TRACES_SAMPLER_ARG=0.2` on each app. Simpler to configure — no Collector processor
needed — but cannot apply always-keep policies for errors or slow traces. A 20% ratio with
this sampler discards 80% of errors and 80% of slow traces. Rejected.

### Always_sample with Grafana Cloud ingest limits

Leave 100% sampling in place and rely on Grafana Cloud's free-tier ingest limit as a de facto
cap. Rejected: when the cap is hit, the backend silently drops the newest spans, which are
disproportionately the ones from active requests, defeating the purpose of observability.

### Composite policy with a rate limiter

The `tail_sampling` `composite` type can apply per-policy rate limits (e.g., always keep
errors up to N/s, probabilistic for the rest). Rejected as unnecessary complexity for current
traffic levels; the three-policy OR arrangement is sufficient and easier to reason about.

---

## Consequences

### Positive

- Errors and slow traces are guaranteed to reach Grafana Cloud regardless of sampling rate.
- Clean-path noise is reduced by 80% in production, extending Grafana Cloud free-tier headroom.
- The sampling rate is tunable per-environment without a code change (`OTEL_TAIL_SAMPLE_RATE`
  env var; defaults driven by `tailSampleRate` Helm value).
- Local dev retains 100% sampling; no debugging friction introduced.

### Negative

- **10-second memory window.** The Collector buffers spans for up to 10 s per trace. At very
  high span volumes this increases Collector memory pressure. The current resource limits
  (128 Mi request / 256 Mi limit) are unchanged; monitor if throughput grows significantly.
- **Sampling interacts with metrics.** The `probabilistic` policy drops spans from clean traces;
  any metrics derived from span counts (e.g., request-rate via span cardinality) will undercount
  by ~80% for clean-path traffic. Use the Prometheus/Mimir metrics pipeline for request counts
  — do not derive rate from traces.
- **20% clean-trace sampling means the p95 latency computed from sampled traces is an estimate.**
  Tail-sampled p95 is biased toward the retained slow traces. The `slow_traces` policy keeps
  all traces above 1 000 ms, so the p99 estimate is accurate; mid-distribution percentiles
  (p50, p75) are noisier than with 100% sampling.

---

## Addendum — 2026-07-10 (#806): the unauthenticated `/api/client-errors` sink is a retained-ERROR-span source

The `errors` policy above keeps **every** trace containing an `ERROR`-status span. That was
safe while error spans were emitted only by the authenticated `apps/api` request path, whose rate
is bounded by real user traffic. [#798](https://github.com/merickvaughn/lifting-logbook/issues/798)
introduced a shape this ADR did not anticipate:
[`apps/web`'s `POST /api/client-errors`](../../apps/web/app/api/client-errors/route.ts) is
**public and unauthenticated by necessity** (the failure it reports may itself be an auth expiry, so
Clerk must not gate it) and records **one retained ERROR span per accepted request**. Two abuse
vectors can inject always-retained spans into the shared free-tier stack:

- **Cross-origin browser spam** — `navigator.sendBeacon` is a CORS-"simple" request, so a page on
  any origin can beacon this endpoint from a victim's browser; the handler otherwise ignores `Origin`.
- **Scripted spam** — trivial `curl` volume (no `Origin` header at all).

This is precisely the flood the **rejected** "Always_sample with Grafana Cloud ingest limits"
alternative fails on — the ingest cap silently drops the *newest* spans, which are
disproportionately real production spans — and which the **rejected** "composite policy with a rate
limiter" would have bounded. The core decision (errors-always, 20% clean) is unchanged, and both
rejections stand for *legitimate* traffic; this addendum records the accepted interim risk for the
*unauthenticated* sink and the layered mitigations.

**Latency of the risk.** The surface is **latent** until
[#804](https://github.com/merickvaughn/lifting-logbook/issues/804) wires `apps/web`'s server runtime to
the prod collector — until then these spans reach no prod backend. The mitigations below should be
validated and enforcement enabled **before / with #804**.

**Mitigations (defence in depth):**

1. **Span *size* — shipped in [#805](https://github.com/merickvaughn/lifting-logbook/pull/805).**
   `content-length` precheck before buffering, byte-accurate 4 KB body cap, 512-char clamp on every
   attribute value and key, 24-key context cap, scalar-only context values. Bounds the cost of each
   accepted span.
2. **Span *rate* (cross-origin browser beacons) — shipped in this change (#806).** A same-origin
   guard in the handler drops cross-origin browser beacons. It is **observe-only by default**: the
   verdict is always recorded as the `client.origin.check` span attribute (`same-origin` |
   `cross-origin` | `no-origin`), and a request is dropped only when classified `cross-origin`
   against the explicit `CLIENT_ERROR_ALLOWED_ORIGINS` allowlist **and**
   `CLIENT_ERROR_DROP_CROSS_ORIGIN=true`. A false drop would *silently* kill this best-effort
   telemetry, so the zero-config `Origin`-host-vs-`Host` heuristic is used only to produce the
   staging verdict — **never** to drop. **Enablement:** set `CLIENT_ERROR_ALLOWED_ORIGINS` to the
   app's public origin(s), confirm in staging Tempo that legitimate beacons tag
   `client.origin.check=same-origin`, then set `CLIENT_ERROR_DROP_CROSS_ORIGIN=true`. Rollback is
   instant — unset the flag (no code deploy).

   **Enforcement enabled — 2026-07-12 ([#809](https://github.com/merickvaughn/lifting-logbook/issues/809)).**
   [PR #827](https://github.com/merickvaughn/lifting-logbook/pull/827) wired `CLIENT_ERROR_ALLOWED_ORIGINS`
   (derived at deploy from each web service's own Cloud Run URL) into the staging + production web
   callers of [`deploy-cloud-run-otel-sidecar`](../../.github/actions/deploy-cloud-run-otel-sidecar/action.yml)
   in **observe mode** (`drop=false`). Staging Tempo validation then confirmed legitimate beacons tag
   `client.origin.check=same-origin` (no false `cross-origin`, no `client.origin.enforce_skipped`), so
   PR 2 set `client_error_drop_cross_origin: "true"` on both callers in
   [`deploy.yml`](../../.github/workflows/deploy.yml): **staging enforces on merge**; the **production**
   rollout is human-gated at the `environment: production` approval gate. Instant incident rollback is
   code-free — override the env var on the live service (`gcloud run services update
   lifting-logbook-{stg,prod}-web --update-env-vars CLIENT_ERROR_DROP_CROSS_ORIGIN=false`), exactly as
   the enablement note above describes; reverting the `deploy.yml` input to `"false"` is the durable
   change that survives the next deploy.
3. **Span *rate* (scripted / no-`Origin` abuse) — deferred to infra.** The `Origin` guard cannot
   stop a `curl` loop (no browser, no truthful `Origin`). The robust fix is an infra-level rate limit
   on the unauthenticated endpoint (Cloud Armor / ingress / edge), tracked as a follow-up. Until it
   lands, scripted abuse of this endpoint is bounded only by span *size* (mitigation 1) and the
   collector's own memory limits.

**Not done here:** a per-policy rate limiter at the collector (the `tail_sampling` `composite`
type). It remains rejected for *legitimate* traffic; if the infra rate limit (mitigation 3) proves
insufficient it should be reconsidered specifically for the client-error span source.

---

## Addendum — 2026-11-16 (#1343): the API runs the `always_on` sampler, so a not-sampled parent can't drop a request

**What went wrong.** The Decision above puts the keep/drop verdict at the collector and assumes the
SDK exports every span. It didn't: `apps/api/src/otel.ts` left `OTEL_TRACES_SAMPLER` unset, and the
SDK's default is `parentbased_always_on`, which follows the caller's `traceparent` sampled flag.
Requests sent straight from the browser (imports, every client-side write in
`apps/web/lib/client-api.ts`) reach the API with a `traceparent` whose flags are `-00`. The browser
sends none, so it is added in front of the service, most likely by Cloud Run's front end. The API
therefore created a non-recording span, exported nothing, and the `errors`, `slow_traces` and
`probabilistic` policies never saw the request. On staging on 2026-11-15, 1848 API log lines carried
`trace_flags: "00"` against 83 with `"01"`; eleven import requests, three over 1000 ms, left no span
in Tempo. Requests from the Next.js server (which `@vercel/otel` gives a sampled `traceparent`) were
traced, so server-rendered reads were visible and browser writes weren't.

**Decision.** `startOtel()` sets `OTEL_TRACES_SAMPLER=always_on` unless the environment already sets
one. `always_on` still joins the caller's trace — same trace ID, the caller's span as parent — and
only ignores the caller's keep/drop flag. Whether a trace is kept stays with the collector, as this
ADR decided. A not-sampled flag put on the request by infrastructure in front of the API isn't a
retention decision made by anyone who knows whether the request was slow or failed, so it can't
decide retention here. The collector's `probabilistic` policy (20% of clean traces) now does that for
every request alike.

**Why not keep `parentbased_always_on`.** It would only work if everything upstream of the API sampled
everything, and Cloud Run's front end doesn't. **Why not `parentbased_traceidratio`:** this ADR already
rejected head-based ratio sampling for discarding most errors and slow traces.

**Consequences.**

- Every API request is now recorded, which is the premise the collector's tail-sampling sizing
  already assumed. Span volume reaching the collector rises from the sampled minority to the API's full
  request rate; the `probabilistic` policy and the collector's memory limits bound what's forwarded.
- Tests: `apps/api/src/otel.sampler.spec.ts` starts the SDK through `startOtel()` and asserts a
  not-sampled `traceparent` yields a recording span that reaches the exporter flagged sampled, and a
  sampled `traceparent` keeps its trace ID and parent span.
- An operator who sets `OTEL_TRACES_SAMPLER` explicitly (for example back to a `parentbased_*`
  sampler) overrides this default and reopens the gap.
- **Not changed:** `apps/web` (`@vercel/otel`) keeps its own sampler. It sees browser requests to the
  Next.js server, which this change doesn't cover.

---

## References

| Source | Relevance |
|---|---|
| [OpenTelemetry Collector contrib — `tail_sampling` processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor) | Authoritative documentation for the processor used in this ADR; covers all policy types, `decision_wait` semantics, and known limitations. |
| [OpenTelemetry — Sampling](https://opentelemetry.io/docs/concepts/sampling/) | Conceptual overview of head-based vs. tail-based sampling; the basis for the Rationale section's framing. |
| [ADR-018 — Observability Stack](ADR-018-observability-stack.md) | The prior ADR this decision supersedes in part; documents the original 100% head-based sampling stance and the trigger conditions for revisiting it. |
| [W3C Trace Context — `traceparent` and the sampled flag](https://www.w3.org/TR/trace-context/#sampled-flag) | Primary spec for the #1343 addendum: defines the `-00`/`-01` flag as the caller's *recording hint*, not a binding retention decision. |
| [OpenTelemetry — SDK specification: built-in samplers](https://opentelemetry.io/docs/specs/otel/trace/sdk/#built-in-samplers) | Defines `AlwaysOn` and `ParentBased`, and the `OTEL_TRACES_SAMPLER` values (`always_on`, `parentbased_always_on`) the #1343 addendum chooses between. |
| [ADR-019 — SLO Methodology](ADR-019-slo-methodology.md) | The burn-rate alerting framework built on top of the metrics pipeline; notes the interaction between sampling and metric accuracy referenced in the Consequences section. |
| [WHATWG Fetch Standard — CORS protocol & the `Origin` header](https://fetch.spec.whatwg.org/#origin-header) | Primary spec for the #806 addendum: defines when browsers attach `Origin` and which requests are CORS-"simple" (no preflight) — the basis for why `sendBeacon` reaches this endpoint cross-origin and why the same-origin guard keys on `Origin`. |
| [MDN — `Navigator.sendBeacon()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon) | The browser API `apps/web` uses to post client errors; documents its fire-and-forget, unload-surviving, CORS-simple semantics referenced by the #806 addendum. |
