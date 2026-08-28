# Service Level Objectives — `apps/api`

Defines the availability and latency SLOs for the Lifting Logbook API, the error budget
policy, and how compliance is measured. Methodology rationale is in
[ADR-019](../adr/ADR-019-slo-methodology.md).

---

## SLO Targets

| SLO | Target | Measurement window |
|---|---|---|
| Availability | 99.5% | 28-day rolling |
| p95 latency | < 1 s | 28-day rolling |

### Availability definition

A request is **good** if the API returns a non-5xx HTTP response. A request is **bad** if it
returns a 5xx response or the API fails to respond (connection reset, timeout at the load
balancer). Client-side 4xx responses (malformed input, auth rejection) are **not** counted as
bad — they represent expected user-error handling, not service failures.

PromQL expression:

```promql
1 - (
  sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[28d]))
  /
  sum(rate(http_server_request_duration_seconds_count[28d]))
)
```

> **Note:** 28-day range vectors are expensive to evaluate ad-hoc. In production, pre-compute
> these via Prometheus recording rules — see [ADR-019](../adr/ADR-019-slo-methodology.md).

### Latency definition

The p95 of all request durations, measured end-to-end from the first byte received by Fastify
to the last byte of the response body written. Excludes TLS handshake time and load-balancer
overhead.

PromQL expression:

```promql
histogram_quantile(
  0.95,
  sum(rate(http_server_request_duration_seconds_bucket[28d])) by (le)
)
```

> **Note:** 28-day range vectors are expensive to evaluate ad-hoc. In production, pre-compute
> these via Prometheus recording rules — see [ADR-019](../adr/ADR-019-slo-methodology.md).

---

## Error Budget

Error budget = (1 − SLO target) × window duration.

| Window | Availability budget | Latency budget |
|---|---|---|
| 28 days (672 h) | **3.36 h** of bad responses | Not directly time-based; see burn-rate policy below |
| 30 days (720 h) | **3.60 h** of bad responses | — |

Availability budget is consumed any time the error rate is above zero. At a sustained 100%
error rate, the entire 28-day budget is exhausted in 3.36 hours.

---

## Error Budget Policy

### Burn-rate thresholds

| Burn rate | Estimated time to budget exhaustion | Response |
|---|---|---|
| > 14× | ~2 h | Page on-call immediately; treat as SEV1 candidate |
| > 6× | ~4 h | Page on-call; treat as SEV2 |
| > 3× | ~9 h | Create ticket; treat as SEV3 |
| ≤ 1× | Budget not at risk | No action required |

Burn rates are measured using a two-window strategy (short detection window ∧ long confidence
window) to suppress transient spikes. Burn-rate alert rules will be implemented once the
service receives enough sustained production traffic to calibrate the PromQL expressions.
Until then, the existing threshold alerts in `infra/observability/alerts/api.yaml` serve
as the primary on-call signal.

### Budget reset

The 28-day rolling window advances continuously — consuming budget today affects the window for
the next 28 days, not just the current calendar month. This means a severe incident early in
the month may make it difficult to deploy risky changes for several weeks.

### Monthly review

On the first business day of each month, the on-call engineer reviews:

1. How much error budget was consumed in the previous 30 days.
2. Whether any alerts fired that should not have (false positives).
3. Whether any real degradations went unalerted (gaps in coverage).
4. Whether the targets remain appropriately conservative or should be tightened.

Targets are reviewed and, if warranted, adjusted after the first 90 days of production traffic.

---

## Exclusions

The following are excluded from SLO measurement and do not count against the error budget:

- **Planned maintenance windows** — maintenance must be announced in the incident channel at
  least 24 hours in advance and marked as a silence in Grafana Alerting.
- **Clerk auth provider outages** — 5xx responses caused by Clerk's own service degradation
  (confirmed via [status.clerk.com](https://status.clerk.com)) are excluded. The on-call
  engineer must document the exclusion in the incident record.
- **GCP infrastructure incidents** — outages attributable to GKE, Cloud Run, Cloud SQL, or
  other GCP-managed services that are beyond the application's control. Document with the GCP
  incident number.

Exclusions must be recorded in the incident postmortem so they can be audited during the
monthly review.

---

## Measurement Infrastructure

SLO compliance is derived from the Prometheus metrics emitted by the OpenTelemetry SDK in
`apps/api` and collected by the OTel Collector:

- **Local dev:** Prometheus runs at `http://localhost:9090`; Grafana at `http://localhost:3030`;
  Alertmanager at `http://localhost:9093`
- **Production:** Grafana Cloud Metrics (Mimir); alert rules in
  `infra/observability/alerts/api.yaml` and the Alertmanager routing/notification config in
  `infra/observability/alertmanager.yaml` are applied to the Grafana Cloud stack

Ensure Mimir retention is set to **≥ 30 days** so 28-day window expressions have complete
data. Contact the Grafana Cloud portal (Stack → Settings → Data retention) to verify.

---

## Calibrating `APIRouteHighErrorRate`

`APIRouteHighErrorRate` (per-route 5xx ratio `by (http_route) > 5%` for 5m, defined in
`infra/observability/alerts/api.yaml`) was shipped with two parameters that can only be settled
against **real production metrics**, and were deferred to
[#468](https://github.com/merickvaughn/lifting-logbook/issues/468) per [ADR-019](../adr/ADR-019-slo-methodology.md)'s
note that threshold tuning waits for sustained traffic:

1. **Is `http_route` the route *template*** (`/programs/:program/lifts`) rather than the raw path with
   IDs interpolated? If raw, cardinality explodes and every single-request 500 becomes its own
   100%-failure series — the rule must then be remediated.
2. **Does the `> 5%` / `for: 5m` shape over-page on a single-user deploy?** On an idle route one 500
   holds `rate(...[5m])` at ratio 100% for the whole window and can satisfy `for: 5m`. That sensitivity
   is *wanted* for the low-traffic outage this defends against (#458/#460), but risks alert fatigue.

`http_route` is the OTLP→Prometheus rendering of the OTel `http.route` attribute;
`http_response_status_code` of `http.response.status_code`. Feed the results into the decision
matrix in Step 3 below.

### Running the queries

Three ways, same queries:

- **PowerShell (Windows, turnkey — no curl/node/jq).** Enter your keys once; they persist to your
  user environment, then the runner uses them:

  ```powershell
  # One-time: enter MIMIR_ADDRESS / MIMIR_API_USER / MIMIR_API_KEY (token input hidden).
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/observability/mimir-setup.ps1

  # Then run all of 1a–2f (now, or from any new terminal):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/observability/run-calibration-queries.ps1
  ```

  [`mimir-setup.ps1`](../../scripts/observability/mimir-setup.ps1) persists the variables permanently
  via the user environment (no admin needed); the token is stored in plaintext there, so treat it like
  any saved credential (the script prints the one-liner to remove it later).
  [`run-calibration-queries.ps1`](../../scripts/observability/run-calibration-queries.ps1) reads them
  and queries Mimir with `Invoke-RestMethod`.

- **Bash (turnkey — Git Bash, macOS, Linux, CI).** Enter your keys once; they persist to
  `~/.bashrc`, then the runner uses them:

  ```bash
  # One-time: enter MIMIR_ADDRESS / MIMIR_API_USER / MIMIR_API_KEY (token input hidden).
  # `source` so the current shell gets them too (new shells inherit from ~/.bashrc).
  source scripts/observability/mimir-setup.sh

  # Then run all of 1a–2f (now, or from any new terminal):
  scripts/observability/run-calibration-queries.sh
  ```

  [`mimir-setup.sh`](../../scripts/observability/mimir-setup.sh) writes the variables to `~/.bashrc`
  (plaintext, like any saved credential — it prints the removal one-liner). Because replacing its
  managed block rewrites the whole file, it first copies the pre-run `~/.bashrc` to a
  written-if-absent anchor at `~/.bashrc.mimir-setup.orig` — never overwritten on re-run, so
  repeated runs cannot erode the original — and refuses to proceed if that copy fails. Restore with
  `cp ~/.bashrc.mimir-setup.orig ~/.bashrc`. The rewrite itself is verified by line count before it
  replaces the original, since a full disk can truncate it and still exit 0; and an *unterminated*
  managed block — what a run truncated part-way through appending leaves behind — is refused rather
  than removed to end-of-file, so repair it by hand and re-run
  ([#954](https://github.com/merickvaughn/lifting-logbook/issues/954)). The runner sources
  [`mimir-query-env.sh`](../../scripts/observability/mimir-query-env.sh), which exports the variables
  (and also honors any already set — including those from `mimir-setup.sh`/`mimir-setup.ps1`, or a
  gitignored `.mimir-credentials` file copied from
  [`.mimir-credentials.example`](../../scripts/observability/.mimir-credentials.example) if you prefer
  a file over `~/.bashrc`). The **auth** variables (`MIMIR_API_USER` / `MIMIR_API_KEY`) are the same
  ones the `mimirtool` step below uses, so one setup serves both; the URL base may differ (the query
  API is at `${MIMIR_ADDRESS}/api/v1/query` — set `MIMIR_QUERY_URL` if that path is wrong for your
  stack). The token needs only the `metrics:read` scope.

- **Grafana Explore (zero install).** Open **Explore → Mimir datasource** (Cloud Metrics) and paste
  each query below. Use **Instant** (not Range) query type for the `count(...)` and `[14d:5m]`
  subqueries so they return a single evaluation.

> Both runners read the executable copy of these queries from
> [`scripts/observability/calibration-queries.tsv`](../../scripts/observability/calibration-queries.tsv).
> The annotated blocks below are the human reference — keep the `.tsv` and this doc in sync when the
> rule's metric/label names or thresholds change.

### Step 1 — confirm `http_route` is the route template

```promql
# 1a. Enumerate every distinct route label value currently stored.
#     PASS: templated → /programs/:program/lifts, /lifts/custom, /health, ...
#     FAIL: raw paths with IDs → /programs/3f2a.../lifts, /programs/abc/lifts, ...
count by (http_route) (http_server_request_duration_seconds_count)

# 1b. Total route cardinality (single number).
#     PASS: ~ number of API endpoints (single/low-double digits, stable over time).
#     FAIL: hundreds+ and grows with usage → raw paths, cardinality blow-up.
count(count by (http_route) (http_server_request_duration_seconds_count))

# 1c. Empty/missing-route series — instrumentation-http can record the metric with no
#     http.route on unmatched 404s or before routing resolves. A small fixed set is fine;
#     a large or per-request-growing empty bucket means routes aren't landing on the metric.
count by (http_route) (http_server_request_duration_seconds_count{http_route=""})
```

> **If 1a/1b show raw paths (FAIL):** add a `metricstransform` / `attributes` processor in
> `infra/observability/otel-collector.yaml` to template the label (or set `http.route` explicitly
> upstream), then re-run 1a–1c to confirm. The code uses default `getNodeAutoInstrumentations()` with
> no Collector transform, so the expectation is PASS — these queries exist to *prove* it against a
> real sample, not to assume it.

### Step 2 — characterize traffic to choose a volume floor vs. a longer `for:`

```promql
# 2a. Per-route average request rate (req/s) over 14d. ×300 ≈ requests per 5m window.
#     A candidate volume floor "> n req/s": n = 0.0167 ≈ 5 req / 5m.
sum by (http_route) (rate(http_server_request_duration_seconds_count[14d]))

# 2b. Per-route PEAK 5m request rate over 14d — a volume floor must sit BELOW the busiest
#     5m of the lowest-but-real route, or a genuine low-traffic outage gets suppressed.
max_over_time(
  (sum by (http_route) (rate(http_server_request_duration_seconds_count[5m])))[14d:5m]
)

# 2c. Per-route 5xx count over 14d — where do real errors actually land?
sum by (http_route) (increase(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[14d]))

# 2d. Overall daily request volume — characterize the single-user traffic level.
sum(increase(http_server_request_duration_seconds_count[1d]))

# 2e. FALSE-POSITIVE ESTIMATE — count of per-route 5m windows in the last 14d where the
#     CURRENT rule condition (ratio > 5%) held. Each sustained run ≈ one page.
count_over_time(
  (
    (sum by (http_route) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))
     / sum by (http_route) (rate(http_server_request_duration_seconds_count[5m]))) > 0.05
  )[14d:5m]
)

# 2f. SAME, with a candidate floor of 5 req/5m (0.0167 req/s) applied. Compare 2f vs 2e:
#     the difference is the number of one-off / idle-route pages the floor would remove.
count_over_time(
  (
    (
      sum by (http_route) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))
      / sum by (http_route) (rate(http_server_request_duration_seconds_count[5m])) > 0.05
    )
    and
    (sum by (http_route) (rate(http_server_request_duration_seconds_count[5m])) > 0.0167)
  )[14d:5m]
)
```

> **If `2a`/`2e`/`2f` are rejected or time out:** a `[14d:5m]` subquery evaluates an inner 5m
> rate at ~4 000 steps in one shot, and `rate(...[14d])` spans a long window — either can exceed
> Grafana Cloud Mimir's per-query execution-time / max-samples limits. Narrow the range and coarsen
> the step (e.g. `[7d:10m]`), or run a week at a time and sum the counts. The false-positive *trend*
> is what drives the decision, not exact step counts.

### Step 3 — decide from the data

| Observation from 2a–2f | Recommended change |
|---|---|
| 2e ≈ 0 (rule essentially never tripped outside real incidents) | **Confirm adequate** — record the 0 count as evidence in #468, no rule change. |
| 2e > 0 driven by idle routes, **and** real routes' 2b peak ≫ 5 req/5m | **Add a volume floor** `and sum by (http_route)(rate(...[5m])) > <n>`, with `<n>` set below the lowest real route's 2b peak and above 1 req/5m. |
| Even real routes routinely sit < 5 req/5m (very sparse single-user traffic) | **Lengthen `for:`** (e.g. 10–15m) instead of a floor, so a one-off 500 self-clears but a sustained outage still pages — avoids blinding low-traffic-but-broken routes. |
| 2f removes legitimate-outage windows, not just noise | Floor too high → lower `<n>`, or fall back to the `for:` option. |

Any change that adds volume-floor logic to `api.yaml` **must** add a matching `promtool test rules`
scenario to `infra/observability/alerts/api.test.yaml` (a low-volume route below the floor must *not*
fire; a route above the floor at 100% 5xx must). After changing the rule, apply it with the
`mimirtool` procedure below.

---

### Applying alert config to Grafana Cloud

The rule and routing config are kept as code in `infra/observability/`. They are applied to the
Grafana Cloud Mimir ruler + Alertmanager with [`mimirtool`](https://grafana.com/docs/mimir/latest/manage/tools/mimirtool/)
(set `MIMIR_ADDRESS` / `MIMIR_API_USER` / `MIMIR_API_KEY` from the Grafana Cloud portal):

```bash
# Alert rules (Mimir ruler)
mimirtool rules load infra/observability/alerts/api.yaml

# Routing + notification config (Mimir Alertmanager)
mimirtool alertmanager load infra/observability/alertmanager.yaml
```

> **Secrets, not committed.** `alertmanager.yaml` carries `.invalid` / `PLACEHOLDER` values for
> the SMTP identity, on-call email recipient, and Slack webhook URL. Before loading, substitute
> the real values from Secret Manager / the Grafana Cloud portal (or configure the contact
> points directly in the Cloud Alertmanager UI) — never commit the real destinations. This is
> what makes an alert actually **page** rather than sit on a dashboard; the gap it closes is the
> #458/#460 outage that ran four days with no notification ([#462](https://github.com/merickvaughn/lifting-logbook/issues/462)).

After loading, send a test notification from the Grafana Cloud Alertmanager UI to confirm both
the email and Slack contact points reach the operator.

---

## References

- [ADR-019 — SLO Methodology](../adr/ADR-019-slo-methodology.md)
- [Google SRE Workbook — Chapter 5: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/)
- [Google SRE Book — Chapter 4: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
