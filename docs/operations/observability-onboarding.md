# Observability & On-Call — Start Here

**New to this app's logs, traces, dashboards, or on-call rotation? Read this first.**

This is an orientation guide, not a reference manual. It sequences the existing observability
and on-call docs in the order a newcomer needs them, explains what the signals mean, and links
out to the deep docs for mechanics rather than repeating them. Budget ~20 minutes to read it
once and click into the linked sections as you go.

By the end you should be able to: open Grafana, read the API health dashboard, pull the logs and
traces for a single request, and know what to do when an alert fires.

---

## 1. The 60-second mental model

Every request through `apps/api` emits **traces, logs, and metrics** via an OpenTelemetry SDK
([`apps/api/src/otel.ts`](../../apps/api/src/otel.ts)). Those signals flow to an **OpenTelemetry
Collector**, which fans them out to three backends:

| Signal | Backend (production) | Backend (local) | What it answers |
|---|---|---|---|
| Traces | Grafana Cloud **Tempo** | local Tempo | "Where did this request spend its time?" |
| Logs | Grafana Cloud **Loki** | local Loki | "What did the app say while handling it?" |
| Metrics | Grafana Cloud **Mimir** | local Prometheus | "What's the error rate / latency / throughput right now?" |

You read all three through **Grafana** — locally and in production the UI and queries are the
same; only the backend storage differs. The whole design is [ADR-018](../adr/ADR-018-observability-stack.md).

The single most useful feature: **logs and traces are linked both ways**. Every log line carries
the `trace_id`/`span_id` of the request that produced it, so you can jump from a log line to its
full trace and back. That's how you go from "an error scrolled past" to "here's exactly what
happened" in two clicks (see §4–5).

---

## 2. Get access

### Local (do this first — it's free and instant)

Bring up the full stack and open Grafana. No login is required locally:

```sh
docker compose up -d
```

Then open **http://localhost:3030** (anonymous admin is enabled). Note the port is **3030**, not
the Grafana default 3000 — that's reserved for the Next.js dev server.

Full startup details, the service/port table, and how to point `apps/api` at the local collector
are in the observability runbook → [Local stack startup](../runbooks/observability.md#local-stack-startup)
and [Grafana login](../runbooks/observability.md#grafana-login).

### Production (Grafana Cloud)

Production telemetry lands in Grafana Cloud. Access to the Grafana Cloud org is granted by the
team — ask your onboarding buddy for an invite. The Collector authenticates to Grafana Cloud
using credentials stored in the `otel-collector-auth` Kubernetes secret; you don't need those to
*read* dashboards, only to operate the collector. The credential wiring is documented in
[Grafana Cloud credential wiring](../runbooks/observability.md#grafana-cloud-credential-wiring).

---

## 3. Read the dashboards

Start at the one dashboard that matters for health: **Dashboards → Lifting Logbook → API RED**.
("RED" = **R**ate, **E**rrors, **D**uration — the standard request-service signals.) It has three
panels:

| Panel | What it shows | What "healthy" looks like |
|---|---|---|
| **Request rate** | requests/sec, broken out by status code | mostly 2xx; a steady, expected volume |
| **Error rate** | fraction of 5xx over a 5-minute window | well under **1%** (the API-wide alert threshold) |
| **Latency** | p50 / p95 / p99 | **p95 under 1 s** (the p95 alert threshold) |

When you glance at this dashboard, you're really asking "is the error rate near the alert line,
and is p95 latency near 1 s?" Those two thresholds — 1% errors and 1 s p95 — are the numbers the
alerts in §7 fire on, so they're the reference for "normal." Panel-by-panel detail is in
[Dashboard locations](../runbooks/observability.md#dashboard-locations).

---

## 4. Read the logs

Logs are **structured JSON** (via `nestjs-pino`). To find errors, open **Explore → Loki** and run:

```logql
{service_name="lifting-logbook-api"} |= "error"
```

Two things to know up front:

- **Redaction:** auth-bearing headers and cookies are stripped before logs leave the app, and
  `/health` is excluded from request logging. Don't expect to find tokens in the logs — and never
  add a log line that would put a secret or sensitive body there.
- **Correlation:** expand any log line and you'll see a `trace_id` field rendered as a clickable
  link. Click it to open that request's full trace (this is the log→trace jump in §5).

Full LogQL walkthrough: [Jumping log ↔ trace](../runbooks/observability.md#jumping-log--trace).

---

## 5. Read the traces

Open **Explore → Tempo**. Two ways in:

- **By `trace_id`** — paste a 32-hex-char trace ID into the **Search → Trace ID** field (you'll
  usually arrive here by clicking a `trace_id` from a log line).
- **By query (TraceQL)** — e.g. find every slow request:

  ```traceql
  { duration > 1s }
  ```

From any span you can click **Logs for this span** to jump back to the matching Loki log lines —
the trace→log direction. Together, §4 and §5 let you pivot freely between "what the app said" and
"what the app did" for any single request. Reference: [Querying traces by `trace_id`](../runbooks/observability.md#querying-traces-by-trace_id).

---

## 6. Two gotchas this app has (read before you trust a trace)

This codebase has two deliberate gaps that will surprise you if you don't know about them:

1. **Raw SQL is *not* auto-traced.** The Prisma OTel instrumentation is disabled due to an SDK
   version conflict ([ADR-024](../adr/ADR-024-prisma-otel-sdk-override.md)), so Prisma queries and
   any `$queryRaw`/`$executeRaw` emit **no spans**. A trace that looks like it has a gap at the DB
   layer isn't necessarily fast — it may just be invisible. Any new raw-SQL call site must be
   wrapped in a **manual span** to show up.
2. **LLM adapters send prompts unscrubbed.** The macrocycle-planning adapters forward user context to
   the provider with no PII scrubbing. Keep that in mind before assuming prompt content is safe to
   log or send.

These (plus the redaction note in §4) are the repo-specific items the Observability review
dimension checks — see the `## Observability` section of [CLAUDE.md](../../CLAUDE.md).

---

## 7. When something is wrong — joining on-call

When an alert fires, the canonical process lives in the **[On-Call Guide](on-call.md)**. The short
version:

**Alerts you may get paged for** (rules in [`infra/observability/alerts/api.yaml`](../../infra/observability/alerts/api.yaml),
routed by Alertmanager — `warning`/`critical` page, `info` is held back):

| Alert | Means | Severity |
|---|---|---|
| `APIRouteHighErrorRate` | one route's 5xx rate > 5% / 5 min (catches a single failing endpoint that the API-wide rate hides) | critical |
| `APIHighErrorRate` | API-wide 5xx rate > 1% / 5 min | warning |
| `APIHighP95Latency` | p95 latency > 1 s / 5 min | warning |
| `APINoRequests` | zero requests for 10 min (known off-hours false positive) | info |

> This table is a derived summary for orientation. The canonical source of alert conditions and
> severities is [`infra/observability/alerts/api.yaml`](../../infra/observability/alerts/api.yaml)
> (rules) plus [observability.md → Alerting](../runbooks/observability.md#alerting) (routing); if
> they ever disagree with the table above, they win — update this copy to match.

**The path every incident follows:**

1. **Acknowledge** the alert.
2. **Assess severity** (SEV1 / SEV2 / SEV3) — when in doubt, go higher and downgrade later.
3. **Check the API RED dashboard** (§3) to see the shape of the problem.
4. **Find the matching runbook** in the [runbook index](../runbooks/README.md) and follow its
   symptom → diagnosis → remediation steps.
5. **Communicate, resolve, verify**, and for SEV1/SEV2 write a blameless postmortem.

The full severity definitions, escalation paths, incident checklist, and postmortem template are
in [on-call.md](on-call.md). The SLO targets and error-budget policy that justify the thresholds
above are in [slo.md](slo.md).

---

## 8. Where to go next

| Resource | What it covers |
|---|---|
| [Observability runbook](../runbooks/observability.md) | The mechanics this guide links to: stack startup, dashboards, trace/log queries, correlation, alerting, Grafana Cloud wiring |
| [On-Call Guide](on-call.md) | Severity levels, escalation paths, incident checklist, postmortem template |
| [SLOs & error budget](slo.md) | Availability/latency targets, measurement windows, error-budget policy |
| [Runbook index](../runbooks/README.md) | One runbook per known failure mode (5xx surge, DB unreachable, auth outage, deploy rollback) |
| ADRs [018](../adr/ADR-018-observability-stack.md) · [019](../adr/ADR-019-slo-methodology.md) · [020](../adr/ADR-020-tail-based-sampling-policy.md) · [024](../adr/ADR-024-prisma-otel-sdk-override.md) | Why the stack, SLO method, sampling policy, and Prisma tracing gap are the way they are |
| [Developer onboarding](../onboarding.md) | The other onboarding track — clone to first PR (code, not ops) |

---

## References

- [OpenTelemetry — observability primer (traces, metrics, logs)](https://opentelemetry.io/docs/concepts/observability-primer/) — the three-signals model this stack is built on
- [Grafana — Explore](https://grafana.com/docs/grafana/latest/explore/) — the Loki/Tempo query UI referenced throughout
- [Google SRE Book — Being On-Call](https://sre.google/sre-book/being-on-call/) — the on-call structure and severity framing used in [on-call.md](on-call.md)
- [Tom Wilkie — The RED Method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/) — Rate/Errors/Duration, the model the API RED dashboard follows
