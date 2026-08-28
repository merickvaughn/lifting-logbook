# Observability Runbook

> **New here?** Start with the [Observability & On-Call onboarding guide](../operations/observability-onboarding.md)
> for a guided reading path; this runbook is the mechanics it links to.

Covers the local development stack, Grafana dashboards, trace queries, log↔trace
correlation, alert silencing, and Grafana Cloud credential wiring for production.

---

## Local stack startup

The docker-compose stack runs six services together:

| Service | Port(s) | Role |
|---|---|---|
| `db` | 5432 | PostgreSQL (app data) |
| `otel-collector` | 4317 (gRPC), 4318 (HTTP), 8889 (Prometheus exporter) | Receives OTLP spans/logs; fans out to Tempo and Loki |
| `tempo` | 3200 | Trace storage and query |
| `loki` | 3100 | Log storage and query |
| `prometheus` | 9090 | Metrics storage and query |
| `grafana` | 3030 | Dashboards, alerting, explore |

```sh
docker compose up -d
```

`otel-collector` waits for `tempo` and `loki` to pass health checks before it starts
accepting traffic, so all services are ready within ~30 seconds of the command completing.

To skip the database and start only the observability services:

```sh
docker compose up -d otel-collector tempo loki prometheus grafana
```

For `apps/api` to emit spans and logs to the local collector, add to `apps/api/.env`:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Start the API server as normal (`npm run dev`) and make any request — traces will appear
in Tempo within a few seconds (batch flush window: 5 s).

---

## Grafana login

Open **http://localhost:3030** in a browser. The local dev stack runs with anonymous
admin access (`GF_AUTH_ANONYMOUS_ENABLED=true`, `GF_AUTH_DISABLE_LOGIN_FORM=true`) — no
username or password is needed.

> The Grafana port is `3030`, not the default `3000`, to avoid conflicting with the
> Next.js dev server.

---

## Dashboard locations

The API RED dashboard is auto-provisioned from
[`infra/observability/dashboards/api-red.json`](../../infra/observability/dashboards/api-red.json)
on every stack startup.

Navigate to: **Dashboards → Lifting Logbook → API RED**

The dashboard shows three panels:

| Panel | Metric |
|---|---|
| Request rate | Requests/second by status code |
| Error rate | Fraction of 5xx responses over 5-minute window |
| Latency | p50, p95, p99 histograms |

All panels are Prometheus-backed, querying the OTel Collector's Prometheus exporter
(port 8889) via the pre-provisioned Prometheus datasource.

---

## Querying traces by `trace_id`

### From Grafana Explore

1. Open **Explore** (compass icon in the left nav).
2. Select the **Tempo** datasource from the dropdown.
3. Switch to the **Search** tab.
4. Paste the `trace_id` (32 hex characters) into the **Trace ID** field.
5. Click **Run query**.

### Using TraceQL

In the same Explore view, switch to the **TraceQL** tab for structured queries:

```
{ duration > 1s }                   # all spans slower than 1 second
{ name = "POST /workouts" }         # spans for a specific operation
{ .http.status_code = 500 }         # spans with a 500 status attribute
```

### From the CLI (autonomous / headless)

For validation that must run without the Grafana UI — e.g. an agent confirming a span
tag's values in staging — use the read-only helper
[`scripts/observability/tempo-query.sh`](../../scripts/observability/tempo-query.sh). It
mirrors the Mimir `mimir-query-env.sh` pattern, and every subcommand issues only HTTP GET.

```bash
scripts/observability/tempo-query.sh tags                         # smoke-test creds
scripts/observability/tempo-query.sh search '{ span.client.origin.check = "same-origin" }'
scripts/observability/tempo-query.sh tag-values client.origin.check
```

This is the path added for #829, so span-tag checks like #809's `client.origin.check`
guard can be validated autonomously instead of by hand.

#### One stack serves both environments

**The staging read credentials already read production traces**, so there is no separate
prod credential to obtain. Staging and production push to the **same** Grafana Cloud stack
(a single OTLP instance) — see the environment-scoping note under
[Grafana Cloud credential wiring](#grafana-cloud-credential-wiring) — and
`deployment.environment.name` is the **only** discriminator between them. That means an
unscoped TraceQL query returns spans from both environments intermixed. Always filter:

```bash
# Production spans, using the same (staging) credentials
scripts/observability/tempo-query.sh search \
  '{ resource.deployment.environment.name = "production" }'
```

`TEMPO_TARGET=prod` remains available and now falls back to the staging credential set
when no `TEMPO_PROD_*` block is configured, printing a notice and the filter above. It is
therefore **redundant on the current stack topology** — it selects the same credentials —
and exists so that a genuinely separate prod stack, if one is ever provisioned, needs only
a filled-in `TEMPO_PROD_*` block rather than a code change. Before #949 the documented
`TEMPO_TARGET=prod` path failed outright, because the credentials template ships that
block commented out at its placeholders.

#### Getting a credential, and where to keep it

The token must be an Access Policy token scoped to **`traces:read`** (Grafana Cloud
Account → Access Policies). It cannot be sourced from the deployment pipeline: the OTLP
push tokens in GCP Secret Manager
(`lifting-logbook-{stg,prod}-otel-otlp-auth-header`) are **write-only** — their policy
grants `metrics:write, logs:write, traces:write` with no `traces:read` — so a distinct
read token is genuinely required (#949).

Persist it once, outside every checkout:

```bash
# Prompts for the values (token input hidden) and writes them to ~/.bashrc.
source scripts/observability/tempo-setup.sh
```

[`tempo-setup.sh`](../../scripts/observability/tempo-setup.sh) is the Tempo counterpart of
[`mimir-setup.sh`](../../scripts/observability/mimir-setup.sh) and makes the same
trade-off: the token is stored in **plaintext** in `~/.bashrc`, like any saved credential
(the script prints the one-line `sed` command to remove it later). This is the recommended
home because `~/.bashrc` sits outside every checkout and worktree, so the values resolve
from **any** worktree and no cleanup routine can delete them.

The file-based alternative is a gitignored `scripts/observability/.tempo-credentials`
(copy [`.tempo-credentials.example`](../../scripts/observability/.tempo-credentials.example)).
If you use it, **put it in the canonical checkout, not a worktree** — a linked worktree
carries its own `scripts/observability/`, so a credentials file exists only in the checkout
it was created in. `tempo-query-env.sh` falls back to the canonical checkout's copy when
the local one is absent, so one file there serves every worktree.

> **Why this is called out (#949):** the only working read credential on the original
> machine lived inside a disposable worktree under `.claude/worktrees/`, which a daily
> prune routine can delete without warning — and because the file is correctly gitignored,
> it is not recoverable from git. Losing it means minting a fresh `traces:read` token from
> the Grafana Cloud portal.

### From a log line

If you already have a log line in Loki with a `trace_id` field, click the `trace_id`
value — Grafana's derived-field link opens the matching Tempo trace directly.

---

## Jumping log ↔ trace

The `apps/api` logger (`nestjs-pino`) injects `trace_id` and `span_id` from the active
OpenTelemetry span into every structured log line. Grafana is pre-configured with
bidirectional links between Loki and Tempo.

### Log → trace

1. Open **Explore → Loki** datasource.
2. Run a LogQL query, e.g.: `{service_name="lifting-logbook-api"} |= "error"`
3. Expand any log line — the `trace_id` field appears as a clickable link.
4. Clicking the link opens the full trace in Tempo in a split view.

### Trace → log

1. Open a trace in Tempo (via Explore or the RED dashboard drill-down).
2. Click any span in the trace waterfall.
3. Click **Logs for this span** in the detail panel.
4. Grafana queries Loki filtered by `trace_id` and `span_id` and opens the matching
   log lines.

Both directions are wired via Grafana datasource provisioning in
[`infra/observability/grafana/provisioning/datasources/local.yml`](../../infra/observability/grafana/provisioning/datasources/local.yml).

---

## Alerting

### Alert rules

Four Prometheus alert rules are defined in
[`infra/observability/alerts/api.yaml`](../../infra/observability/alerts/api.yaml). **All four are
scoped to production** via the `deployment_environment_name="production"` label — staging and
production share one free-tier Grafana Cloud stack, so without scoping a staging 5xx would page on
the prod rules ([#487](https://github.com/merickvaughn/lifting-logbook/issues/487); see the
environment-scoping note under [Grafana Cloud credential wiring](#grafana-cloud-credential-wiring)).

| Rule | Condition (production only) | Severity |
|---|---|---|
| `APIRouteHighErrorRate` | any single route's 5xx rate > 5% over 5 minutes (grouped `by (http_route)`) | critical |
| `APIHighErrorRate` | API-wide 5xx rate > 1% over 5 minutes | warning |
| `APIHighP95Latency` | p95 latency > 1 s over 5 minutes | warning |
| `APINoRequests` | Zero production requests for 10 minutes | info |

`APIRouteHighErrorRate` exists because the API-wide `APIHighErrorRate` can stay below 1% when a
single endpoint fails at 100% but carries little traffic — the exact shape of the #458/#460
outage, which ran undetected for four days. The per-route rule trips on any one route's
sustained 5xx regardless of overall volume. See
[api-5xx-surge.md](api-5xx-surge.md) for first response. Its `> 5%` threshold, `for: 5m` window,
and whether to add a low-traffic volume floor are calibrated against production metrics using the
queries in [slo.md → Calibrating `APIRouteHighErrorRate`](../operations/slo.md#calibrating-apiroutehigherrorrate)
([#468](https://github.com/merickvaughn/lifting-logbook/issues/468)).

> **Known issue:** `APINoRequests` fires spuriously outside business hours because it
> has no `for:` grace period. This is a documented open item in ADR-018. The Alertmanager
> route (below) holds `severity=info` back from paging; you can also silence it during
> off-hours.

### Notification routing

Firing rules are routed to notification channels by the Alertmanager config in
[`infra/observability/alertmanager.yaml`](../../infra/observability/alertmanager.yaml). Without
this, the rules above would evaluate but page no one — the gap that let the #458 outage run
silently (#462).

| Aspect | Behaviour |
|---|---|
| Channels | **email + Slack** (`oncall` receiver), both with `send_resolved` |
| What pages | `severity =~ "warning|critical"` |
| What is held back | `severity = "info"` (e.g. `APINoRequests`) → `null` receiver, visible in the Alertmanager UI but no page |
| De-duplication | a route-level `APIRouteHighErrorRate` critical inhibits the redundant aggregate `APIHighErrorRate` warning for the same incident |
| Grouping | `by (alertname, http_route)` so distinct failing routes page separately |

The email address, SMTP credentials, and Slack webhook URL are **secrets** — they are never
committed. The file carries clearly-marked `.invalid` / `PLACEHOLDER` values; the real
destinations live in the Grafana Cloud Alertmanager (apply/update procedure:
[`docs/operations/slo.md`](../operations/slo.md#applying-alert-config-to-grafana-cloud)).
Locally, `docker compose up` starts an Alertmanager at <http://localhost:9093> so the
rule → route → receiver path is exercisable (delivery fails without real creds, which is
expected).

### Creating a silence

1. Open **Grafana → Alerting → Silences**.
2. Click **New silence**.
3. Set a **Matchers** entry: e.g., `alertname = APINoRequests`.
4. Set the **Duration** (e.g., 8h).
5. Add a **Comment** explaining why.
6. Click **Submit**.

The silence takes effect immediately and expires automatically at the specified time.

---

## Grafana Cloud credential wiring

The OTel Collector reads four environment variables to route telemetry to Grafana Cloud
in production. In local dev, leave these unset — the Collector sends to the local
Tempo and Loki containers instead.

| Variable | Purpose |
|---|---|
| `OTEL_COLLECTOR_OTLP_ENDPOINT` | Grafana Cloud Tempo/Mimir OTLP endpoint (traces + metrics) |
| `OTEL_COLLECTOR_LOKI_ENDPOINT` | Grafana Cloud Loki native OTLP ingestion endpoint (logs) |
| `OTEL_COLLECTOR_OTLP_AUTH_HEADER` | `Basic <base64(instanceId:apiKey)>` for traces/metrics |
| `OTEL_COLLECTOR_LOKI_AUTH_HEADER` | `Basic <base64(instanceId:apiKey)>` for logs |

Grafana Cloud endpoints and credentials are obtained from the Grafana Cloud portal:

- **Traces/metrics endpoint:** Stack → Details → OpenTelemetry → OTLP endpoint
- **Logs endpoint:** Stack → Details → Loki → URL (append `/otlp`). The collector's `logs`
  pipeline uses the generic `otlphttp` exporter pointed at this path — the dedicated `loki`
  exporter (`/loki/api/v1/push`) is deprecated and has been removed from
  `opentelemetry-collector-contrib` ([issue #38374](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/38374),
  [PR #41413](https://github.com/open-telemetry/opentelemetry-collector-contrib/pull/41413)); see #662.
- **API key:** Stack → Details → Generate a token (select "MetricsPublisher" or
  create a service account with Send metrics + Send traces + Send logs permissions)

### GKE production (wired — #474)

The collector DaemonSet is deployed automatically by the deploy pipeline; there is no
manual `helm install` step. On every push-to-main deploy, `.github/workflows/deploy.yml`:

1. **Syncs the auth headers** — reads `lifting-logbook-{stg,prod}-otel-otlp-auth-header`
   and `-otel-loki-auth-header` from GCP Secret Manager (the CI/CD SA has `roles/owner`)
   and writes them into a Kubernetes Secret named **`otel-collector-secrets`** (keys
   `otlp-auth-header`, `loki-auth-header`) in the workload namespace. The chart's
   `daemonset.yaml` reads that Secret via `secretKeyRef`. The step fails the deploy
   loudly — and never echoes the value — if either secret is absent, empty, or the
   unpopulated `REPLACE_ME` sentinel.
2. **Helm-deploys the collector** — `helm upgrade --install otel-collector` with the
   per-env values file (`infra/kubernetes/values/{staging,production}-otel-collector.yaml`),
   which sets the non-secret OTLP/Loki endpoints.

**One-time token bootstrap** (the only manual step, run once per env): run
[`scripts/bootstrap-otel-secrets.sh`](../../scripts/bootstrap-otel-secrets.sh) — it creates
the Secret Manager containers (not Terraform-managed) and populates the real Grafana token.
See [`docs/deploy.md` → OTel Collector / Grafana Cloud telemetry](../deploy.md#otel-collector--grafana-cloud-telemetry).

**Metrics → Mimir:** the collector ships metrics over the **same OTLP gateway** as traces
(the gateway fans metrics out to Mimir), reusing the OTLP auth header. The chart's metrics
pipeline uses the `otlphttp/metrics` exporter — **not** a `:8889` Prometheus scrape, which
nothing scrapes in GKE. This is the path `APIRouteHighErrorRate` depends on. (The local
docker-compose collector keeps the `prometheus`/`:8889` exporter, which the local
Prometheus container scrapes.)

> **Shared stack (free tier) — environment scoping:** staging and production export to the
> **same** Grafana Cloud stack with the same endpoints/token, so telemetry from both environments
> intermixes in Tempo/Loki/Mimir. To keep staging from paging the production alert rules
> ([#487](https://github.com/merickvaughn/lifting-logbook/issues/487)):
>
> 1. The API and web SDKs tag every span/metric/log with the
>    [`deployment.environment.name`](https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/)
>    resource attribute, sourced from `NODE_ENV` (`production` / `staging`; `development` locally).
>    See [`apps/api/src/otel.ts`](../../apps/api/src/otel.ts) and
>    [`apps/web/instrumentation.ts`](../../apps/web/instrumentation.ts).
> 2. Resource attributes do **not** become per-series Prometheus labels on their own (OTLP→Prom
>    puts them on `target_info`). The collector's `transform/env_label` processor promotes the
>    attribute to a `deployment_environment_name` metric label in the **metrics** pipeline
>    ([`configmap.yaml`](../../infra/kubernetes/charts/otel-collector/templates/configmap.yaml));
>    traces/logs keep the resource attribute natively in Tempo/Loki for filtering.
> 3. All four `api.yaml` alert rules match `deployment_environment_name="production"`, so a staging
>    5xx never pages. `infra/observability/alerts/api.test.yaml` locks this with a
>    staging-does-not-page scenario.
> 4. **On the read side this cuts the other way:** one stack means one set of read credentials
>    covers both environments — the staging Tempo credentials return production traces, and an
>    unscoped query mixes the two. See
>    [One stack serves both environments](#one-stack-serves-both-environments) for the querying
>    consequence (#949).

### Cloud Run (wired — #768 api, #804 web)

The Cloud Run **api and web** services each ship telemetry via a co-located **otel-collector
sidecar** — a second container in the instance (api in #768, web in #804). Each app runtime exports
OTLP to `localhost:4318` (the api SDK, and the web server's `@vercel/otel`); the
sidecar forwards to Grafana Cloud using the **same** pipeline config, endpoints, and auth-header
secrets as the GKE DaemonSet, so both topologies emit the same telemetry — same pipeline and the
`deployment_environment_name` metric label the alert rules depend on — subject to the delivery
caveat below (the Cloud Run sidecar is CPU-throttled between requests). This is what makes
telemetry reach Grafana on the production project, which runs Cloud-Run-only (`enable_gke = false`)
and so has no DaemonSet.

The collector image is not pulled from Docker Hub on the request path: it is served from a
per-environment Artifact Registry Docker Hub pull-through mirror and pinned by digest (#795), so a
Docker Hub rate-limit/outage cannot fail a production cold-start. The image reference (repo path +
digest) is single-sourced in `infra/observability/otel-collector-image.env`; to bump the collector
version, update that file plus the GKE chart's `Chart.yaml` (`appVersion`) and `values.yaml`
(`image.tag`).

Cloud Run has no additive sidecar command, no ConfigMap volumes, and the api service is
`lifecycle.ignore_changes = [template]` (Terraform never mutates the running revision), so the
deploy pipeline owns the whole 2-container topology. On every push-to-main deploy,
`.github/workflows/deploy.yml` (staging + production):

1. **Ensures the config secret** — publishes
   [`infra/cloud-run/otel-collector-config.yaml`](../../infra/cloud-run/otel-collector-config.yaml)
   (the collector pipeline config, mirroring the GKE
   [`configmap.yaml`](../../infra/kubernetes/charts/otel-collector/templates/configmap.yaml)) to the
   Secret Manager secret `lifting-logbook-{stg,prod}-otel-collector-config`, adding a new version
   only when the content changed. Cloud Run mounts config *files* from Secret Manager, not ConfigMaps.
2. **Injects the sidecar** — `gcloud run services describe --format=export` →
   [`scripts/inject-otel-sidecar.py`](../../scripts/inject-otel-sidecar.py) (adds the
   `otel-collector` container + config volume, sets the ingress container's
   `OTEL_EXPORTER_OTLP_ENDPOINT`) → `gcloud run services replace`. The same injector serves both
   services; the web deploy step passes `INGRESS_CONTAINER_NAME=web` so its ingress container is
   named `web` (the api path defaults to `api`). Deriving the manifest from the live service
   preserves every Terraform-managed field (VPC connector, scaling, service account, startup probe)
   verbatim. `gcloud run deploy --container` was rejected — it hits an unresolvable sidecar-port
   catch-22 on this gcloud version (see the script header).

**IAM.** The **api** sidecar runs as the api workload SA, which already holds a project-level
`roles/secretmanager.secretAccessor` grant (`gke.tf` `api_workload_roles`), so it reads the config
and auth-header secrets directly (no new IAM). The **web** sidecar runs as the *web* workload SA,
which deliberately does **not** have that project-level grant — so the internet-facing web SA never
gains the api SA's broad access to `DATABASE_URL` / migrator creds. The web deploy step instead
grants it `roles/secretmanager.secretAccessor` on **only** the three otel secrets it needs (config +
the two auth headers), least-privilege, in the pipeline (`gcloud secrets add-iam-policy-binding`,
idempotent) rather than in Terraform — all three secrets are pipeline/operator-managed out-of-band
and the config secret does not exist at `terraform apply` time. The token bootstrap is the **same**
as GKE — both sidecars reuse the `lifting-logbook-{stg,prod}-otel-{otlp,loki}-auth-header` secrets, so
[`scripts/bootstrap-otel-secrets.sh`](../../scripts/bootstrap-otel-secrets.sh) already covers it. The
non-secret endpoints are set in the Cloud Run deploy step and must match
`infra/kubernetes/values/{staging,production}-otel-collector.yaml`.

**Two operational caveats.** (1) **CPU-throttling.** The sidecar shares the api revision's Cloud Run
CPU allocation (`cpu_idle` — CPU only during request processing), so between requests the collector's
`batch`, `tail_sampling` (`decision_wait`), and periodic OTLP export timers run best-effort rather
than always-on like the GKE DaemonSet; buffered telemetry can be delayed or dropped when an idle
instance is throttled or scaled in. Revisit collector CPU allocation ([#787](https://github.com/merickvaughn/lifting-logbook/issues/787))
now that #781's endpoint fix ([#784](https://github.com/merickvaughn/lifting-logbook/pull/784)) lets real
delivery be measured. (2) **Terraform recreate.** For **both** services Terraform declares only the
app container (the sidecar lives solely in the injected manifest, and each service is
`lifecycle.ignore_changes = [template]`). If the api **or** web service is ever recreated by
Terraform (DR, teardown/reapply, first apply), it comes up **single-container** — the runtime exports
to a `localhost:4318` with nothing listening, silently dropping all telemetry (the exact #768 bug) —
until the next pipeline deploy re-injects the sidecar. **A pipeline deploy must follow any Terraform
recreate of either service.**

> **Note — the Grafana endpoint blocker ([#781](https://github.com/merickvaughn/lifting-logbook/issues/781)) is now fixed ([#784](https://github.com/merickvaughn/lifting-logbook/pull/784)).**
> During this change's staging validation, Grafana Cloud rejected every export — **Loki 401 / OTLP 530**,
> for **both** GKE and Cloud Run — because the shared endpoints pointed at the wrong Grafana stack
> (confirmed by a direct `curl`, bypassing the collector). #784 corrected them (OTLP →
> `otlp-gateway-prod-us-east-3`, Loki → `logs-prod-042`, verified against the live stack) in the GKE
> values files; the Cloud Run deploy step here uses the **same** corrected endpoints and auth-header
> secrets, so the sidecar's exports now reach Tempo/Loki/Mimir.

---

## On-call escalation

Severity levels, escalation paths, SLO targets, and incident response procedures are
documented in:

- [`docs/operations/on-call.md`](../operations/on-call.md) — severity levels, escalation paths, postmortem template
- [`docs/operations/slo.md`](../operations/slo.md) — SLO targets and error budget policy
- [`docs/runbooks/README.md`](README.md) — index of all failure-mode runbooks

---

## References

- [Grafana Tempo — search and query](https://grafana.com/docs/tempo/latest/tracing/tempo-search/) — TraceQL reference and search UI guide
- [Grafana Loki — log exploration](https://grafana.com/docs/loki/latest/visualize/grafana/) — LogQL syntax and Explore panel usage
- [OpenTelemetry Collector — environment variable substitution](https://opentelemetry.io/docs/collector/configuration/#environment-variables) — how `${env:VAR}` syntax works in collector config
- [Prometheus — Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/) — the routing tree, receivers, and inhibit-rule syntax used in `infra/observability/alertmanager.yaml`
- [Prometheus — Alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) — the `groups`/`rules` syntax used in `infra/observability/alerts/api.yaml`
