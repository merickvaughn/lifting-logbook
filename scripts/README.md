# scripts/

Repository automation scripts. Grouped by lifecycle.

## Local development setup

| Script | Purpose |
|---|---|
| [`dev-setup.sh`](dev-setup.sh) | One-shot local bootstrap: installs Node deps, validates `.nvmrc`, sets up env files for `apps/api` and `apps/web`. Run after cloning. |

## Production deploy

| Script | Purpose |
|---|---|
| [`bootstrap-gcp.sh`](bootstrap-gcp.sh) | One-time GCP bootstrap for a lifting-logbook deploy (prod or staging): creates the project, links billing, enables the APIs Terraform needs, and provisions the Terraform state bucket. Idempotent. Pass `--project-id lifting-logbook-staging` to bootstrap the staging environment. See [`docs/deploy-single-user.md`](../docs/deploy-single-user.md) and [`docs/staging-runbook.md`](../docs/staging-runbook.md). |
| [`bootstrap-otel-secrets.sh`](bootstrap-otel-secrets.sh) | One-time Grafana Cloud auth-header bootstrap for the OTel Collector (#474): prompts for the OTLP/Loki instance IDs + an API token (token prompt hidden), builds the `Basic base64(instanceId:token)` headers locally, and creates+populates the `lifting-logbook-{stg,prod}-otel-{otlp,loki}-auth-header` Secret Manager secrets the deploy pipeline reads. Idempotent (adds a new version on re-run); the secrets are **not** Terraform-managed. Pass `--env staging`/`--env production` to scope to one environment. See [`docs/deploy.md`](../docs/deploy.md#otel-collector--grafana-cloud-telemetry). |
| [`deploy-prod-infra.sh`](deploy-prod-infra.sh) | Automates `terraform init` → workspace select → `apply` for the production environment. Maps custom domains and prints GitHub Actions secrets. Use `--plan-only` to preview. Run after `bootstrap-gcp.sh`. |
| [`inject-otel-sidecar.py`](inject-otel-sidecar.py) | Builds the two-container Cloud Run manifest for the api (#768) **and** web (#804) services by deriving from the live service (`gcloud run services describe --format=export`): adds the `otel-collector` sidecar + config-secret volume, sets the ingress container's `OTEL_EXPORTER_OTLP_ENDPOINT`, and drops the unused `SYSTEM_DATABASE_URL`. The ingress container name is parameterized (`INGRESS_CONTAINER_NAME`, default `api`; the web deploy step passes `web`), and the image comes from `INGRESS_IMAGE`. The `deploy.yml` api/web deploy steps pipe its output to `gcloud run services replace`. An optional `INGRESS_EXTRA_ENV` (newline-separated `KEY=VALUE`) merges extra vars into the ingress env — the web deploy uses it for the #806/#809 same-origin guard (`CLIENT_ERROR_ALLOWED_ORIGINS` derived from the web service's own URL, plus `CLIENT_ERROR_DROP_CROSS_ORIGIN`). Idempotent; requires PyYAML. |
| [`migrate-prod-db.sh`](migrate-prod-db.sh) | Applies all database migrations to the production Cloud SQL instance. Temporarily enables a public IP, runs Prisma migrations and the `user_data_source` infra migration via the Cloud SQL Auth Proxy, then removes the public IP. Downloads the proxy automatically. |
| [`migrate-staging-db.sh`](migrate-staging-db.sh) | Applies all database migrations to the staging Cloud SQL instance. Staging-specific variant of `migrate-prod-db.sh`: uses the shared `lifting-logbook-tfstate` state bucket (prefix `terraform/state`), the `-stg-` secret naming pattern, `PROXY_PORT=5434`, and forces `sslmode=disable` on the proxy URL for Prisma compatibility. |

## Repository / project management

| Script | Purpose |
|---|---|
| [`create-github-project.sh`](create-github-project.sh) | Creates and configures the GitHub Project (v2) — fields, options, links repo, seeds Foundation issues. Run once per fresh fork. |
| [`create-foundation-issues.sh`](create-foundation-issues.sh) | Creates labels, the `v0.1 — Foundation` milestone, and the 17 Foundation issues. Run from the target repo root. |

## Build helpers (Apps Script legacy / build pipeline)

| Script | Purpose |
|---|---|
| [`check-clasp-login.js`](check-clasp-login.js) | Verifies `clasp` (Google Apps Script CLI) is installed and authenticated. Used by legacy GAS builds. |
| [`clean-index.js`](clean-index.js) | Removes `dist/**/index.js` files after bundling — part of the Apps Script build chain. |
| [`flatten-dist.js`](flatten-dist.js) | Moves all `dist/**/*.js` files into a flat `dist/` for GAS upload. |
| [`mkdir-dist.js`](mkdir-dist.js) | Ensures `dist/` exists before a build. |
| [`watch.js`](watch.js) | esbuild watch mode for `src/{core,api}/*/index.ts` entry points. |

## Observability / alert calibration

| Script | Purpose |
|---|---|
| [`observability/calibration-queries.tsv`](observability/calibration-queries.tsv) | The 1a–2f calibration PromQL as `label⇥query` lines — the single executable copy read by both runners. Mirrors the annotated blocks in [`docs/operations/slo.md`](../docs/operations/slo.md#calibrating-apiroutehigherrorrate). |
| [`observability/format-promql-result.js`](observability/format-promql-result.js) | Helper for the bash runner: pretty-prints a Prometheus `/api/v1/query` JSON response (route label → value). Stands in for `jq`, which is unavailable in this environment. |
| [`observability/format-tempo-result.js`](observability/format-tempo-result.js) | Helper for the bash runner: pretty-prints a Grafana Cloud Tempo read-API JSON response (search / trace / tags / tag-values shapes). Stands in for `jq`, unavailable in this environment. Tempo counterpart of `format-promql-result.js` ([#829](https://github.com/merickvaughn/lifting-logbook/issues/829)). |
| [`observability/mimir-query-env.sh`](observability/mimir-query-env.sh) | **Sourced** bash setup: loads and exports `MIMIR_ADDRESS` / `MIMIR_API_USER` / `MIMIR_API_KEY` (and optional `MIMIR_QUERY_URL` / `MIMIR_TENANT_ID`) for querying Grafana Cloud Mimir. Reads the gitignored `observability/.mimir-credentials` (copy from [`.mimir-credentials.example`](observability/.mimir-credentials.example)) or already-set env vars. Same variables `mimirtool` uses. |
| [`observability/mimir-setup.ps1`](observability/mimir-setup.ps1) | **Windows turnkey, run once:** interactively prompts for the Mimir credentials (token input hidden) and persists them to your *user* environment permanently (no admin, no new window). New terminals — bash or PowerShell — inherit them. |
| [`observability/mimir-setup.sh`](observability/mimir-setup.sh) | **Bash turnkey, run once:** interactively prompts for the Mimir credentials (token input hidden) and persists them to `~/.bashrc` so every new Git Bash shell exports them. `source` it to update the current shell too. Idempotent (replaces its managed block on re-run). |
| [`observability/run-calibration-queries.ps1`](observability/run-calibration-queries.ps1) | Native PowerShell runner for steps 1a–2f (uses `Invoke-RestMethod`; no `curl`/`node`/`jq`). Reads credentials from the environment (set via `mimir-setup.ps1`) and queries from `calibration-queries.tsv` ([#468](https://github.com/merickvaughn/lifting-logbook/issues/468)). |
| [`observability/run-calibration-queries.sh`](observability/run-calibration-queries.sh) | Bash runner for steps 1a–2f from [`docs/operations/slo.md`](../docs/operations/slo.md#calibrating-apiroutehigherrorrate) against production Mimir ([#468](https://github.com/merickvaughn/lifting-logbook/issues/468)). Sources `mimir-query-env.sh`, reads `calibration-queries.tsv`; needs `curl` + `node`. |
| [`observability/tempo-query-env.sh`](observability/tempo-query-env.sh) | **Sourced** bash setup: loads and exports `TEMPO_ADDRESS` / `TEMPO_API_USER` / `TEMPO_API_KEY` (and optional `TEMPO_TENANT_ID`) for **read-only** trace queries against Grafana Cloud Tempo. `TEMPO_TARGET=staging\|prod` selects the credential set; reads the gitignored `observability/.tempo-credentials` (copy from [`.tempo-credentials.example`](observability/.tempo-credentials.example)) or already-set env vars. Tempo counterpart of `mimir-query-env.sh` ([#829](https://github.com/merickvaughn/lifting-logbook/issues/829)). |
| [`observability/tempo-query.sh`](observability/tempo-query.sh) | **Read-only** TraceQL query helper (GET-only): `search` / `trace` / `tags` / `tag-values` subcommands so span-tag validations run autonomously instead of via Grafana Explore. Sources `tempo-query-env.sh`, formats via `format-tempo-result.js`; needs `curl` + `node` and a `traces:read`-scoped token ([#829](https://github.com/merickvaughn/lifting-logbook/issues/829)). |

## Verification / testing

| Script | Purpose |
|---|---|
| [`check-board-id-sync.mjs`](check-board-id-sync.mjs) | Fails CI if the GitHub Project board IDs drift between [`../CLAUDE.md`](../CLAUDE.md), [`../.claude/hook-config.json`](../.claude/hook-config.json) and [`../.claude/propose.json`](../.claude/propose.json) (#865): compares the project node ID, Epic/Status field IDs, all 10 Epic option IDs, owner, project number, Done option ID and milestone titles, and checks CLAUDE.md against itself (the node ID appears six times). A board mutation re-cuts every ID at once, so a partial refresh leaves the project-board hook writing to a dead field (#627). A **drift** check, not a **liveness** check — it does not call the GitHub API. Runs in CI (`ci.yml`); also run locally as step 3 of CLAUDE.md's Backup-and-restore procedure. |
| [`check-deployed-version.sh`](check-deployed-version.sh) | Curls `GET /version` on staging + production, api + web (#672 / #670): reports the deployed git SHA and prints `git log -1` context for each. api requires a Cloud Run identity token (mirrors the deploy pipeline's smoke test); web is `--allow-unauthenticated`. Attempts all 4 checks even if one fails, aggregating and reporting failures at the end. Pass `--env staging`/`--env production` to scope to one environment. See [`docs/runbooks/checking-deployed-version.md`](../docs/runbooks/checking-deployed-version.md). |
| [`check-grafana-endpoint-sources.mjs`](check-grafana-endpoint-sources.mjs) | Enforces the single source of truth for the Grafana Cloud OTLP/Loki endpoints (#785): fails if a literal endpoint URL is hardcoded anywhere outside [`infra/observability/grafana-endpoints.env`](../infra/observability/grafana-endpoints.env). Runs in CI (`ci.yml`); also run locally before pushing when touching an endpoint or its wiring. |
| [`check-otel-config-sync.mjs`](check-otel-config-sync.mjs) | Fails CI if the Cloud Run collector config ([`infra/cloud-run/otel-collector-config.yaml`](../infra/cloud-run/otel-collector-config.yaml)) drifts from the `config.yaml` block embedded in the GKE otel-collector configmap (#788). Runs in CI (`ci.yml`); also run locally before pushing whenever either collector config changes. |
| [`check-turbo-dev-build-dep.mjs`](check-turbo-dev-build-dep.mjs) | Fails CI if `turbo.json`'s `dev` task stops depending on `^build` (#944), which would let `turbo run dev` start every dev target against a stale `packages/*/dist` — `packages/core`, `packages/types` and `packages/api-client` each resolve through `"main": "dist/index.js"`, so the dev servers load compiled output, never source. Parses `turbo.json` as JSONC (it carries `//` comments, so a bare `JSON.parse` throws). Runs in CI (`ci.yml`); also run locally before pushing whenever `turbo.json`'s `dev` task changes. |
| [`check-turbo-version-sync.mjs`](check-turbo-version-sync.mjs) | Verifies `apps/web/Dockerfile`'s pinned `npx turbo@<version> prune` step matches `package.json`'s `devDependencies.turbo` (#692). Runs in CI (`ci.yml`); also run locally before pushing whenever either file changes. |
| [`smoke-test-observability.sh`](smoke-test-observability.sh) | End-to-end smoke test of the observability docker-compose stack: sends a synthetic OTLP trace and polls Tempo. Requires Docker Compose V2. |
| [`test_inject_otel_sidecar.py`](test_inject_otel_sidecar.py) | Stdlib-`unittest` harness for [`inject-otel-sidecar.py`](inject-otel-sidecar.py) (#786, #804): fixture-driven checks that the injector produces a 2-container manifest (`api`+`otel-collector`, and `web`+`otel-collector` under `INGRESS_CONTAINER_NAME=web`), is idempotent, drops `SYSTEM_DATABASE_URL`, sets `OTEL_EXPORTER_OTLP_ENDPOINT` once, keeps `ports:` only on the ingress container, resolves `INGRESS_IMAGE` over the `API_IMAGE` fallback, merges `INGRESS_EXTRA_ENV` overrides idempotently (the #806/#809 same-origin guard env), and fails non-zero on a malformed manifest / missing image var / malformed extra-env entry. Fixtures: [`testdata/cloud-run-api-export.yaml`](testdata/cloud-run-api-export.yaml), [`testdata/cloud-run-web-export.yaml`](testdata/cloud-run-web-export.yaml). Runs in CI (`ci.yml` → `lint-and-test`); run locally with `python scripts/test_inject_otel_sidecar.py -v` (needs `pip install pyyaml`). It is **not** part of `npm test` — the repo has no Python test runner, so this is invoked directly. |
| [`validate-analytics-taxonomy.mjs`](validate-analytics-taxonomy.mjs) | Verifies `AnalyticsConstants.kt` is in sync with `packages/types/src/analytics.ts`. Exits 0 if the Kotlin file is absent (future work). |

---

When adding a new script:

1. Drop a one-paragraph header comment at the top of the script (purpose,
   prerequisites, usage).
2. Add a row to the appropriate table above — keep tables sorted alphabetically
   within each group.
3. If the script is part of a workflow documented in `docs/`, link to it from
   the relevant doc.
