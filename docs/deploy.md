# Deployment Guide

This project deploys to Google Cloud Platform using Terraform (infrastructure) and
GitHub Actions (CI/CD). The deployment topology follows [ADR-009](adr/ADR-009-infrastructure.md):
GKE Autopilot receives 90% of traffic; Cloud Run receives 10% as an A/B comparison target.

> **Just deploying for yourself?** See [`deploy-single-user.md`](deploy-single-user.md)
> for a slimmer walkthrough that sets `enable_gke = false` and skips the entire
> Helm/kubectl pipeline. The remainder of this document is the canonical
> two-deploy-target setup that satisfies ADR-009.
>
> **Activating staging on top of an existing production deploy?** See
> [`staging-runbook.md`](staging-runbook.md) for a linear top-to-bottom checklist that
> cross-references the staging-only steps of this document.

---

## Architecture overview

```
GitHub Actions (push to main)
  │
  ├─ terraform apply (staging workspace)
  ├─ docker build + push → Artifact Registry
  ├─ helm upgrade → GKE Autopilot (staging namespace)
  ├─ gcloud run deploy → Cloud Run (staging services)
  ├─ smoke test (HTTP health checks)
  │
  └─ [manual approval — GitHub environment protection]
       │
       ├─ terraform apply (production workspace)
       ├─ helm upgrade → GKE Autopilot (production namespace)
       └─ gcloud run deploy → Cloud Run (production services)
```

Two GCP projects are used for environment isolation:
- `lifting-logbook-staging` — staging environment
- `lifting-logbook-prod` — production environment

---

## Deploy modes

The Terraform module supports two modes via the `enable_gke` variable
([`infra/terraform/variables.tf`](../infra/terraform/variables.tf)):

| Mode | `enable_gke` | What runs | When to use |
|---|---|---|---|
| Default / ADR-009 A/B | `true` (default) | GKE Autopilot **and** Cloud Run | Multi-user or portfolio deploy; preserves the A/B comparison this project is built around. |
| Single-user / Cloud-Run-only | `false` | Cloud Run only | One-person deploys where ~\$30/mo of GKE Autopilot cost has no benefit. Full walkthrough: [`deploy-single-user.md`](deploy-single-user.md). |

The `cloud_run_min_instances` variable controls Cloud Run scale-to-zero
(`null` = environment default; `0` = always scale to zero for personal
deployments; `1` = production-grade warm start).

In default mode, this guide applies as written. In single-user mode, follow
[`deploy-single-user.md`](deploy-single-user.md) instead — the bootstrap is
scripted (`scripts/bootstrap-gcp.sh`), only one GCP project is needed,
and the GKE-only Helm/kubectl steps in the CI workflow are skipped via an
`if: <ctx>.gke_enabled == 'true'` guard.

### Flipping between modes on an existing environment

You can move an environment from one mode to the other by toggling
`enable_gke` and re-applying. **Uninstall Helm releases before disabling GKE**
so any cluster-managed cloud resources (load balancer IPs, attached PVCs)
are torn down before Terraform destroys the cluster:

```bash
# GKE-enabled → Cloud-Run-only
helm uninstall api -n production
helm uninstall web -n production
# then set enable_gke = false and run terraform apply
```

Going the other direction (Cloud-Run-only → GKE-enabled) needs no cleanup —
flip the variable, `terraform apply`, then push to `main` to let CI deploy
the Helm releases onto the freshly created cluster.

---

## One-time bootstrap (do this once before the first deploy)

### Prerequisites

- [Google Cloud SDK (`gcloud`)](https://cloud.google.com/sdk/docs/install) installed and authenticated (`gcloud auth login`)
- [Terraform >= 1.7](https://developer.hashicorp.com/terraform/install)
- A Google account with billing enabled
- A [GitHub](https://github.com) account with access to this repository

---

### Step 1 — Create GCP projects

```bash
# Replace BILLING_ACCOUNT with your actual billing account ID
# Find it with: gcloud billing accounts list
BILLING_ACCOUNT="XXXXXX-XXXXXX-XXXXXX"

gcloud projects create lifting-logbook-staging --name="Lifting Logbook Staging"
gcloud projects create lifting-logbook-prod     --name="Lifting Logbook Production"

gcloud billing projects link lifting-logbook-staging --billing-account="$BILLING_ACCOUNT"
gcloud billing projects link lifting-logbook-prod     --billing-account="$BILLING_ACCOUNT"
```

---

### Step 2 — Create the Terraform state bucket and grant CI/CD access

Terraform stores remote state in GCS. Create the bucket once in the production project
(it will hold state for both workspaces — staging and production).

```bash
gsutil mb -p lifting-logbook-prod \
           -l us-central1 \
           gs://lifting-logbook-prod-tfstate

gsutil versioning set on gs://lifting-logbook-prod-tfstate
```

After the first `terraform apply` (Step 3) creates the CI/CD service accounts, grant both SAs
`roles/storage.objectAdmin` on the bucket. The bucket lives in the prod project, so neither
SA can manage this IAM binding via Terraform from within their own CI context — grant it once
out-of-band with your personal account (which has access to both projects):

```bash
# Grant staging CI/CD SA access (run after the staging terraform apply in Step 3)
gcloud storage buckets add-iam-policy-binding gs://lifting-logbook-prod-tfstate \
  --member="serviceAccount:lifting-logbook-stg-cicd@lifting-logbook-staging.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Grant production CI/CD SA access (run after the production terraform apply in Step 3)
gcloud storage buckets add-iam-policy-binding gs://lifting-logbook-prod-tfstate \
  --member="serviceAccount:lifting-logbook-prod-cicd@lifting-logbook-prod.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Grant the production read-only PLAN SA access (#545) — run after the production
# terraform apply that creates lifting-logbook-prod-plan. objectViewer (not
# objectAdmin): plan-production reads state to compute the diff but runs
# `terraform plan -lock=false`, so it never writes the state lock.
gcloud storage buckets add-iam-policy-binding gs://lifting-logbook-prod-tfstate \
  --member="serviceAccount:lifting-logbook-prod-plan@lifting-logbook-prod.iam.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```

These grants are idempotent — safe to re-run. They persist independently of Terraform state.

---

### Step 3 — Bootstrap Terraform (first apply)

The first `terraform apply` creates all GCP resources including the Workload Identity
Federation pool used by subsequent CI/CD runs.

```bash
cd infra/terraform

# Enable the IAM and resource manager APIs manually (required before Terraform can run)
gcloud services enable cloudresourcemanager.googleapis.com iam.googleapis.com \
  --project=lifting-logbook-staging
gcloud services enable cloudresourcemanager.googleapis.com iam.googleapis.com \
  --project=lifting-logbook-prod

# Fill in your billing account in the tfvars files
# infra/terraform/terraform.tfvars.staging
# infra/terraform/terraform.tfvars.production

# Apply staging
terraform init -backend-config="bucket=lifting-logbook-prod-tfstate" \
               -backend-config="prefix=terraform/state"
terraform workspace new staging
terraform apply -var-file=terraform.tfvars.staging

# Capture outputs needed for GitHub secrets (see Step 5)
terraform output workload_identity_provider
terraform output cicd_service_account_email

# Apply production
terraform workspace new production
terraform apply -var-file=terraform.tfvars.production

terraform output workload_identity_provider
terraform output cicd_service_account_email
```

> **CI/CD IAM recovery.** Each `terraform apply` above grants the CI/CD service account
> `roles/owner` on its project so subsequent CI-driven applies can manage IAM bindings on
> Secret Manager and KMS (Editor + projectIamAdmin fall short on `setIamPolicy` for several
> resource types). If you bootstrap with an older toolchain that predates this binding —
> symptom: CI fails with `Error 403 ... setIamPolicy denied` — run the recovery script once
> from your laptop as a project owner, then push to main:
>
> ```bash
> ./scripts/fix-cicd-sa-iam.sh --project-id lifting-logbook-staging
> ./scripts/fix-cicd-sa-iam.sh --project-id lifting-logbook-prod
> ```
>
> Bindings are idempotent and get re-asserted by Terraform on the next apply.
>
> **TF state bucket access** (`does not have storage.objects.list access`) is a separate issue —
> see Step 2 for the required out-of-band gcloud commands that grant both SAs `roles/storage.objectAdmin`
> on the shared bucket.

---

### Step 3.5 — Seed staging data

After Terraform has provisioned the staging Cloud SQL instance and the database URL secret is set,
run the Prisma seed script to populate the staging database with synthetic lift data. This gives
the environment realistic data for testing cycle generation, reporting, and API endpoints without
any real user PII.

**When to run:** after `prisma migrate deploy` completes on the staging database (the deploy
pipeline runs the `lifting-logbook-stg-migrate` Cloud Run Job automatically — see
[ADR-027](adr/ADR-027-deploy-pipeline-migrations.md); for manual runs use
`./scripts/migrate-staging-db.sh`).

**What it creates:**

| Table | Rows |
|---|---|
| `user_settings` | 1 (seed user) |
| `lift_metadata` | 6 lifts (squat, deadlift, bench-press, overhead-press, barbell-row, romanian-deadlift) |
| `training_max` | 6 (current maxes after 12 seeded macrocycles) |
| `training_max_history` | ~24 (PR entries every 3rd macrocycle) |
| `macrocycle_dashboard` | 1 (current macrocycle state) |
| `strength_goal` | 6 (relative bodyweight ratio targets) |
| `lift_record` | ~216 (12 macrocycles × 3 workouts × 2 lifts/workout × 3 sets) |

**Seed user ID:** `seed_user_clerkid_staging_001` — this is a synthetic Clerk user ID. It will
not appear in your Clerk dashboard and cannot be accessed via a real auth token. It is useful for
schema validation, API smoke tests, and query testing.

**Command:**

```bash
# Via Cloud SQL Auth Proxy (connect to staging DB locally)
# Use port 5434 (avoids conflict with prod proxy on 5433)
# sslmode=disable required: proxy handles TLS; Prisma must not negotiate SSL independently
cloud-sql-proxy "lifting-logbook-staging:us-central1:lifting-logbook-stg-db-<suffix>?port=5434" &
DATABASE_URL="postgresql://lifting-logbook-app:<password>@127.0.0.1:5434/lifting_logbook?sslmode=disable" \
  npx --prefix apps/api prisma db seed
```

**Idempotency:** the seed script uses `upsert` on all tables. Re-running it is safe — existing
rows are left unchanged, and no duplicates are created.

---

### Step 4 — Sign up for Clerk and create two apps

[Clerk](https://clerk.com) is the authentication provider. It has a free tier.

1. Go to [clerk.com](https://clerk.com) and create an account.
2. Create an app named **lifting-logbook-staging**.
3. Create a second app named **lifting-logbook-production**.
4. For each app, go to **Configure → API keys** and note:
   - **Publishable key** (`pk_test_...` for staging, `pk_live_...` for production)
   - **Secret key** (`sk_test_...` for staging, `sk_live_...` for production)

Store each key pair in GCP Secret Manager:

```bash
# Staging
echo -n "sk_test_YOUR_KEY" | gcloud secrets versions add \
  lifting-logbook-stg-clerk-secret-key --data-file=- \
  --project=lifting-logbook-staging

echo -n "pk_test_YOUR_KEY" | gcloud secrets versions add \
  lifting-logbook-stg-clerk-publishable-key --data-file=- \
  --project=lifting-logbook-staging

# Production
echo -n "sk_live_YOUR_KEY" | gcloud secrets versions add \
  lifting-logbook-prod-clerk-secret-key --data-file=- \
  --project=lifting-logbook-prod

echo -n "pk_live_YOUR_KEY" | gcloud secrets versions add \
  lifting-logbook-prod-clerk-publishable-key --data-file=- \
  --project=lifting-logbook-prod
```

> **Staging test account.** The staging Clerk app also needs a dedicated test user for the
> Playwright integration suite (`STAGING_CLERK_TEST_EMAIL`) — see
> [`apps/web/e2e/README.md`](../apps/web/e2e/README.md#test-account-setup) for setup steps. As of
> #647, that account has a cycle created and deleted on every staging CI run by a self-cleaning
> onboarding write-path test; no extra setup is required beyond the initial account creation.

---

### Step 5 — Add GitHub repository secrets and variables

In the GitHub repository → **Settings → Secrets and variables → Actions**:

**Repository secrets** (Secrets tab):

| Secret | Value |
|---|---|
| `GCP_STAGING_WORKLOAD_IDENTITY_PROVIDER` | staging `terraform output workload_identity_provider` |
| `GCP_STAGING_SERVICE_ACCOUNT` | staging `terraform output cicd_service_account_email` |
| `GCP_PROD_WORKLOAD_IDENTITY_PROVIDER` | production `terraform output workload_identity_provider` |
| `GCP_PROD_SERVICE_ACCOUNT` | production `terraform output cicd_service_account_email` |
| `GCP_PROD_PLAN_SERVICE_ACCOUNT` | production `terraform output cicd_plan_service_account_email` (#545 — read-only SA for the `plan-production` job; set after the apply that creates it, then wire it in via #545 Phase 2) |
| `GCP_BILLING_ACCOUNT` | your billing account ID (used by terraform apply in CI) |
| `TF_STATE_BUCKET` | `lifting-logbook-prod-tfstate` |

**Repository variables** (Variables tab):

| Variable | Value |
|---|---|
| `GCP_STAGING_PROJECT_ID` | `lifting-logbook-staging` |
| `GCP_PROD_PROJECT_ID` | `lifting-logbook-prod` |

> **Why variables, not secrets?** GCP project IDs are not sensitive — they appear in
> Cloud Console URLs, API responses, and `gcloud` output. Storing them as secrets causes
> GitHub Actions to mask any workflow output that contains the value, which silently breaks
> job-to-job data passing (e.g., the `ar_repo` output used to resolve the Artifact Registry
> URL — a masked project ID produces `us-central1-docker.pkg.dev//lifting-logbook/api:tag`
> with an empty path segment that fails buildx).
>
> **Migrating an existing deploy?** If you previously stored `GCP_STAGING_PROJECT_ID` or
> `GCP_PROD_PROJECT_ID` as repository secrets, delete the secret entries after creating the
> variables. A leftover masked secret with the same name is a foot-gun if any workflow is
> ever changed to reference `secrets.GCP_*_PROJECT_ID` — the failure mode reappears silently.

---

### Step 6 — Configure GitHub environment protection rules

1. Go to **Settings → Environments** in the GitHub repository.
2. Create an environment named **`production`**.
3. Under **Deployment protection rules**, add yourself as a **Required reviewer**.

This is the manual approval gate that prevents automatic production deploys.
The `deploy-production` job in `.github/workflows/deploy.yml` will pause and
wait for your approval before proceeding. To approve a paused run (UI or `gh` CLI),
see [Approving a production deploy](#approving-a-production-deploy) under Ongoing operations.

---

### Step 7 — Push to main

The first push to `main` after completing the bootstrap steps will trigger the full pipeline.
Monitor it in **Actions** on GitHub. The staging URL will appear in the `deploy-staging` job output;
the production URL will appear in the `deploy-production` job summary after approval.

---

## Ongoing operations

### Deploying a change

Push or merge to `main`. The pipeline runs automatically.

### Approving a production deploy

After `build-images`, `deploy-staging`, and `smoke-test` succeed, the run pauses at the
`production` environment gate (the Required-reviewer rule from [Step 6](#step-6--configure-github-environment-protection-rules))
and waits for approval before the `deploy-production` job starts. This gate is what applies
pending Prisma migrations to prod — it sits in front of the in-VPC migrate job and the
DB-backed `/readyz` smoke ([ADR-027](adr/ADR-027-deploy-pipeline-migrations.md)) — so approve
it deliberately, after sanity-checking staging.

**Read the production plan before approving.** Open the **`plan-production`** job in the run
and read its job summary — a read-only `terraform plan` against the production workspace,
finished before the gate prompts. The summary shows either **`No changes`** or a non-empty
`Plan: N to add, N to change, N to destroy.` with the affected resource addresses. That is the
exact blast radius `terraform apply (production)` will apply the moment you approve. **A
prod-affecting Terraform diff can ride in on an unrelated merge** — the RLS database-role
cutover ([#517](https://github.com/merickvaughn/lifting-logbook/issues/517)) applied on
2026-06-15 behind a context-free one-click approval triggered by an unrelated CI-fix merge
([#540](https://github.com/merickvaughn/lifting-logbook/issues/540)), because the cutover config
([#533](https://github.com/merickvaughn/lifting-logbook/issues/533)) had sat dormant in `main`
while `deploy-production` was skipped. If `plan-production` shows resources you did not expect,
**do not approve** — investigate first. See
[#542](https://github.com/merickvaughn/lifting-logbook/issues/542). (`plan-production` is advisory:
if it fails transiently the deploy is not blocked, but no summary is available — review the
apply output during the gated deploy instead.)

**See the prod plan one step earlier — on the PR (Layer B).** The
[`prod-plan-pr.yml`](../.github/workflows/prod-plan-pr.yml) workflow runs the same read-only
`terraform plan (production)` on every PR that touches `infra/terraform/**` and posts the
`add/change/destroy` summary + resource addresses as a sticky PR comment, so the prod blast radius
is visible at **review/merge time**, not just at the approval gate. It authenticates as the
least-privilege read-only plan service account (`GCP_PROD_PLAN_SERVICE_ACCOUNT`, see
[Step 5](#step-5--add-github-repository-secrets-and-variables) / [#545](https://github.com/merickvaughn/lifting-logbook/issues/545))
— `terraform plan -lock=false`, never an apply — and only loads prod creds on same-repo PRs that
change `infra/terraform/**` (`pull_request`, not `pull_request_target`; fork PRs are skipped). It is
**advisory** — a non-empty plan does not block merge and is not a required check — but a reviewer who
sees an unexpected prod resource address in the comment should **not merge** until they understand
why. This is Layer B of [#542](https://github.com/merickvaughn/lifting-logbook/issues/542); `plan-production`
above is the Layer A backstop at the gate.

Once approved, `deploy-production` self-guards at two boundaries (issue
[#490](https://github.com/merickvaughn/lifting-logbook/issues/490)):

- **Pre-promote auth-secret check** — before any prod mutation, the job fails fast if
  `lifting-logbook-prod-clerk-secret-key` or `…-clerk-publishable-key` is absent, empty, or still
  the `REPLACE_ME` placeholder ([Step 4](#step-4--sign-up-for-clerk-and-create-two-apps)). This
  prevents the [#382](https://github.com/merickvaughn/lifting-logbook/issues/382) auth-outage class
  (a missing secret reaching a live prod web revision). A "secret inaccessible" error (as opposed
  to "missing"/"placeholder") usually means a transient Secret Manager blip or an IAM gap — re-run
  the deploy if transient.
- **Post-deploy web smoke** — after the prod web Cloud Run deploy, the job probes `/livez`
  (Next.js runtime) and `/sign-in` (Clerk auth flow) through the Cloud Run ingress. A non-200
  fails the run; the revision is already live, so **roll back the web revision** (see
  [Rolling back](#rolling-back)) if it fails.

**From the GitHub UI:** open the Deploy workflow run, click **Review deployments**, select
`production`, and approve.

**From the CLI (no browser):**

```bash
# Find the latest Deploy run on main
RUNID=$(gh run list --workflow Deploy --branch main --limit 1 --json databaseId -q '.[0].databaseId')

# Inspect what is pending approval (optional)
gh api repos/merickvaughn/lifting-logbook/actions/runs/$RUNID/pending_deployments

# Approve the production environment (id 15694632193)
gh api repos/merickvaughn/lifting-logbook/actions/runs/$RUNID/pending_deployments \
  -X POST -f state=approved -F 'environment_ids[]=15694632193' -f comment="approved via gh"
```

The `production` environment id is `15694632193`. To **reject** instead, use `-f state=rejected`.

**Assisted approval.** A tool or assistant may run the approve command on your behalf, but only
after surfacing the run link and a short risk summary — the `plan-production` blast radius
above — and getting an explicit go-ahead. Never approve silently: this is an outward-facing
production action, and approving is what applies the pending Terraform and Prisma diffs.

### Web image: single build, runtime public config (ADR-028)

The `apps/web` image is built **once per commit** (`web:<sha>`, also `:latest`) and the same
artifact is deployed to staging and production — restoring build-once / promote-everywhere.
Public config is injected at **runtime**, not baked into the bundle at build time:

- **Cloud Run:** `API_URL`, `PUBLIC_API_URL`, and the `CLERK_*` secret envs are declared on the
  Terraform web service (`infra/terraform/cloud-run.tf`) and preserved across deploys by the
  otel-collector sidecar wiring's `describe → inject → gcloud run services replace` (#804) — the
  `deploy.yml` web step no longer passes `--set-env-vars` / `--update-secrets` (that changed when the
  web service gained the sidecar; the api service works the same way since #768). The per-PR
  `staging.yml` still deploys web single-container via `gcloud run deploy --set-env-vars`. On Cloud
  Run the browser reaches the same external API URL as the server, so `PUBLIC_API_URL == API_URL`.
- **GKE:** `API_URL` (cluster-internal, SSR) and `PUBLIC_API_URL` (external, browser) come from
  the web ConfigMap; `CLERK_PUBLISHABLE_KEY` from the web Secret.

The root layout reads these at request time and injects them via `window.__PUBLIC_CONFIG__` (for
`lib/client-api.ts`) and the `<ClerkProvider publishableKey>` prop. See
[ADR-028](adr/ADR-028-web-runtime-public-config.md) for the design (supersedes ADR-025).

#### Adding a new public config value

Runtime injection makes this a single wiring point per environment — no Dockerfile `ARG`, no
build-time secret resolution. Checklist:

1. Add the field to `PublicConfig` and `readServerPublicConfig()` in
   `apps/web/lib/public-config.ts` (browser values), or read it directly in the server module
   that needs it (server-only values). **Do not** use a `NEXT_PUBLIC_` prefix — that re-inlines
   it at build time.
2. For Cloud Run: add the env to the Terraform web service container in
   `infra/terraform/cloud-run.tf` (plain `env {}` or a `value_source.secret_key_ref`) — the
   `deploy.yml` web deploy derives its manifest from the live service via `services replace` (#804),
   so Cloud Run public config is Terraform-managed there, not `--set-env-vars`. Because the service
   is `lifecycle.ignore_changes = [template]`, a new value reaches an already-running `deploy.yml`
   service only on a recreate or a one-time manual `gcloud run services update` (same as the api
   post-#768). The per-PR `staging.yml` web deploy still uses `--set-env-vars` / `--update-secrets`,
   so add it there too.
3. For GKE, add it to the web chart (`configmap.yaml` + `values/*.yaml` for plain values, or the
   `-secrets` Secret + `deployment.yaml` env for secret values) and the Helm `--set` flags.
4. Update the declarative reference (`infra/cloud-run/web-service.yaml`,
   `infra/terraform/cloud-run.tf`) to keep it accurate.

#### Verifying runtime public config

After a deploy completes, confirm two things: (1) **neither** environment's values are baked
into the JS bundle (they are injected at runtime), and (2) each served page emits the correct
`window.__PUBLIC_CONFIG__`.

```bash
PROD_WEB="$(gcloud run services describe lifting-logbook-prod-web \
  --region=us-central1 --project=lifting-logbook-prod --format='value(status.url)')"
# Resolve the ACTUAL API host injected at deploy time rather than assuming a *.run.app suffix:
# a custom-domain or GKE-ingress API URL would not match a hardcoded `run.app` literal, so the
# grep below would pass while a value was in fact embedded. Capture both env hosts.
PROD_API_HOST="$(gcloud run services describe lifting-logbook-prod-api \
  --region=us-central1 --project=lifting-logbook-prod --format='value(status.url)' | sed -E 's#^https?://##')"
STG_API_HOST="$(gcloud run services describe lifting-logbook-stg-api \
  --region=us-central1 --project=lifting-logbook-staging --format='value(status.url)' | sed -E 's#^https?://##')"

# (1) The bundle must NOT contain any embedded API host (either env) or Clerk key.
#     (Runtime injection means no NEXT_PUBLIC_* value is in the static chunks at all.)
INDEX_HTML="$(mktemp ./prod-index.XXXXXX.html)"   # workdir temp — /tmp is unusable on the Windows dev env
curl -sL "$PROD_WEB" -o "$INDEX_HTML"
EMBED_RE="pk_test_|pk_live_|$(printf '%s' "$PROD_API_HOST" | sed 's/[.]/\\./g')|$(printf '%s' "$STG_API_HOST" | sed 's/[.]/\\./g')"
for chunk in $(grep -oE '/_next/static/chunks/[a-zA-Z0-9_./-]+\.js' "$INDEX_HTML" | sort -u); do
  curl -sL "${PROD_WEB}${chunk}" | grep -E "$EMBED_RE" \
    && { echo "FAIL: a public value is embedded in $chunk (expected runtime injection)"; rm -f "$INDEX_HTML"; exit 1; }
done
rm -f "$INDEX_HTML"
echo "OK: bundle carries no embedded public config"

# (2) The served HTML must carry the env-correct runtime config.
curl -sL "$PROD_WEB" | grep -o 'window.__PUBLIC_CONFIG__=[^<]*'
# → expect the production apiUrl and (in HTML head, not the bundle) the production Clerk key.
```

Run the symmetric `window.__PUBLIC_CONFIG__` check against staging and confirm it carries the
**staging** apiUrl. The same `web:<sha>` image backs both, so any difference is purely the
runtime env.

> **First-time prod bootstrap (resolved by ADR-028):** ADR-025's `build-images` step
> `Resolve production API URL` — which called `gcloud run services describe lifting-logbook-prod-api`
> before `terraform-production` created that service, aborting the first prod deploy — has been
> removed. The browser-facing URL is now resolved at deploy time from `terraform-production`
> outputs within `deploy-production`, after the service is created in the same job, so the
> bootstrap ordering hazard no longer exists.

### Recovering from CI/CD IAM errors

If a CI run fails with `Error 403 ... setIamPolicy denied`, the CI/CD service account is
missing the `roles/owner` binding that subsequent applies depend on. Re-run the recovery
script from your laptop as a project owner — see the [CI/CD IAM recovery callout under Step 3](#step-3--bootstrap-terraform-first-apply)
for the full explanation and commands.

If a CI run fails with `does not have storage.objects.list access` on the Terraform init step,
the CI/CD SA is missing `roles/storage.objectAdmin` on `lifting-logbook-prod-tfstate` — see
Step 2 for the out-of-band gcloud commands.

### Rolling back

```bash
# Roll back GKE deployment to the previous Helm revision
helm rollback api -n production
helm rollback web -n production

# Roll back Cloud Run to the previous revision
gcloud run services update-traffic lifting-logbook-prod-api \
  --to-revisions=PREVIOUS_REVISION=100 \
  --region=us-central1 --project=lifting-logbook-prod
```

### Running database migrations

**The deploy pipeline applies Prisma migrations automatically (ADR-027).** On every
deploy, `deploy.yml` (prod + staging) and `staging.yml` (PR staging) run the
`lifting-logbook-<env>-migrate` Cloud Run Job — `prisma migrate deploy && prisma migrate
status` — *before* the new API revision goes live. The job runs inside the VPC (the Cloud
SQL instance has a private IP only), so a GitHub-hosted runner never connects to the DB
directly. `gcloud run jobs execute --wait` returns non-zero if a migration or the
`migrate status` drift check fails, which halts the deploy and leaves the last-good API
revision serving. No manual step is required for normal deploys.

As a runtime complement, the production deploy then runs a **DB-backed smoke test**: it mints
a Cloud Run identity token and probes the API's `GET /readyz` (a `@Public`, no-Clerk endpoint
that runs `SELECT 1`). A non-200 fails the deploy — catching the case where the API is up but
cannot actually serve database requests (the failure that left prod silently 500ing in #458,
which no smoke previously detected). The two guards divide the work: `migrate status` (pre-deploy)
ensures the schema is migrated; `/readyz` (post-deploy) ensures the live service can serve it.
`/readyz` does not auto-roll-back on failure — roll back the API revision manually (see
[Rolling back](#rolling-back) / `gcloud run services update-traffic`).

> Until ADR-027 (#460) this was not the case: `prisma migrate deploy` ran only in
> `ci.yml` against the CI test database, so prod schema drifted silently — a missing
> `custom_lift` table 500'd the lift-catalog endpoint (#458). Adding a migration without
> deploying is now safe: the next deploy applies it.

**Break-glass / bootstrap (manual):** to apply migrations out of band — first-time
bootstrap before any deploy, or recovery when the pipeline is unavailable — use the
sanctioned script, which temporarily enables a public IP scoped to your IP, proxies in via
the Cloud SQL Auth Proxy (IAM-authenticated), runs `prisma migrate deploy`, then removes
the public IP. It is idempotent:

```bash
./scripts/migrate-prod-db.sh       # production
./scripts/migrate-staging-db.sh    # staging (proxy on port 5434)
```

The non-Prisma `user_data_source` table (managed outside Prisma) lives in
`infra/migrations/`; both scripts apply `infra/migrations/001_create_user_data_source.sql`
after the Prisma migrations.

### Row-Level Security cutover — two-role split (#517)

The app database enforces per-tenant isolation with Postgres Row-Level Security (migration
`20260611000000_enable_rls`, ADR-010). RLS is **bypassed by `cloudsqlsuperuser` members**, so the
runtime and the migrator connect as **different roles**:

- **Runtime** (`google_sql_user.app_rls`, `lifting_app`) — `NOSUPERUSER NOBYPASSRLS`. The Cloud
  Run services and the GKE API pods read `lifting-logbook-<env>-database-url`, which connects as
  this role (so the policies enforce) and carries `?connection_limit=N` to cap the Prisma pool.
- **Migrator** (`google_sql_user.app`, `lifting-logbook-app`) — the owner/superuser. The migrate
  Cloud Run Job reads the separate `lifting-logbook-<env>-migrator-database-url` so it can run DDL
  and data migrations (which `FORCE ROW LEVEL SECURITY` would otherwise filter to zero rows).

`connection_limit` is derived in `infra/terraform/main.tf` (`local.db_connection_limit`) from the
tier's `max_connections` and the Cloud Run maxScale; staging divides by an extra factor because the
ADR-009 GKE A/B deployment shares the same pool. `max_connections` is the tier default (not a flag)
— verify it before prod with `SELECT setting FROM pg_settings WHERE name='max_connections';`.

**First-apply: import is required, not optional.** The `lifting_app` role was already created by the
`enable_rls` migration (with no password) in both staging and production — confirmed live before this
change. So `terraform plan` will show a `create` for `google_sql_user.app_rls`, and an unguarded
`terraform apply` will **fail** with `409 ALREADY_EXISTS` (the Cloud SQL API does not upsert users).
The deploy pipeline's CI `terraform apply` has no path to recover from this on its own, so the import
must be run **before** the first apply that introduces `app_rls`, once per workspace, against the same
GCS-backed remote state the pipeline uses (not a throwaway local state):

```bash
cd infra/terraform
terraform init -backend-config="bucket=lifting-logbook-tfstate" -backend-config="prefix=terraform/state"
terraform workspace select staging   # then repeat for production before the prod cutover
terraform import google_sql_user.app_rls "<project>/<instance>/lifting_app"
```

After the import, `terraform plan` shows only a password set on the adopted role (no create), and the
pipeline apply proceeds cleanly. (If a future fresh environment has *not* run `enable_rls` yet, the
role won't exist and the import is skipped — but that is not the case for the current staging/prod
cutover.)

**Staging validation gate (run after the staging deploy, before any prod cutover):**

`$STG_RUNTIME_URL` must point at the **proxy**, as the `lifting_app` role — the value stored in the
`database-url` secret has the Cloud SQL **private IP** as its host, which is unreachable from a local
machine, so do not use the raw secret value. Start the proxy with `scripts/migrate-staging-db.sh`
(listens on `127.0.0.1:5434`), then construct the URL with the proxy host and the runtime password:

```bash
# Password is the random_password.app_rls_password value; read it once from the secret and rewrite host:
#   STG_RUNTIME_URL="postgresql://lifting_app:<password>@127.0.0.1:5434/<db_name>?sslmode=disable"
# 1. App connects as the NOBYPASSRLS role (must print: lifting_app | f)
psql "$STG_RUNTIME_URL" -c "SELECT current_user, pg_has_role('lifting_app','cloudsqlsuperuser','member');"
# 2. With the GUC unset, a userId table returns ZERO rows (fail-closed proof)
psql "$STG_RUNTIME_URL" -c "SELECT count(*) FROM training_max;"   # expect 0
# 3. Connection count stays within the pool budget under load
psql "$STG_RUNTIME_URL" -c "SELECT count(*) FROM pg_stat_activity;"
```

Then soak staging ≥24h before approving the production deploy.

**Rolling back the cutover.** Re-point the runtime back to the owner role by adding a new version of
the `database-url` secret with the old `postgresql://lifting-logbook-app:…` value, then redeploy the
API (Cloud Run resolves `:latest` at deploy time):

```bash
gcloud secrets versions add lifting-logbook-prod-database-url --data-file=- --project=lifting-logbook-prod   # paste owner URL
# then redeploy the API revision (see Rolling back, above)
```

The migrate Job is unaffected by a rollback (it uses the separate migrator secret).

### OTel Collector / Grafana Cloud telemetry

**The deploy pipeline deploys the OTel Collector DaemonSet automatically (#474).** On every
GKE deploy, `deploy.yml` (staging + production) syncs the Grafana Cloud auth headers from
Secret Manager into the `otel-collector-secrets` Kubernetes Secret and runs
`helm upgrade --install otel-collector` with the per-env values file. Traces flow to Tempo,
logs to Loki, and **metrics to Mimir over the OTLP gateway** (`otlphttp/metrics` exporter —
the path `APIRouteHighErrorRate` depends on; `:8889` is not scraped in GKE). **The Cloud Run api
and web services also ship telemetry now (#768 api, #804 web)** via a co-located otel-collector
**sidecar** — the deploy steps publish `infra/cloud-run/otel-collector-config.yaml` to a
`lifting-logbook-{stg,prod}-otel-collector-config` secret, then `describe → inject → services replace`
(see [`scripts/inject-otel-sidecar.py`](../scripts/inject-otel-sidecar.py) and the observability
runbook). Both reuse the **same** auth-header secrets and endpoints as GKE, so the one-time token
bootstrap below covers all of them. (The shared Grafana endpoints initially pointed at the wrong stack
([#781](https://github.com/merickvaughn/lifting-logbook/issues/781)); [#784](https://github.com/merickvaughn/lifting-logbook/pull/784)
corrected them — OTLP → `us-east-3`, Loki → `logs-prod-042` — so telemetry now lands.)

**One-time token bootstrap (do this once per environment, before the deploy that needs it).**
The auth headers are never committed and are **not** Terraform-managed — the script below
creates the Secret Manager containers and populates them. The deploy's sync step fails loudly
if a secret is missing or empty.

> **Easiest path — guided script.** Run
> [`./scripts/bootstrap-otel-secrets.sh`](../scripts/bootstrap-otel-secrets.sh). It prompts
> for the instance IDs + token (the token prompt is hidden), builds the headers, creates the
> secret containers if they don't exist yet, and writes both envs' secret versions for you.
> Re-running is safe (it just adds a newer version). The manual steps below are the equivalent
> done by hand.

1. **Get the values from the Grafana Cloud portal:**
   - **OTLP endpoint + instance ID** — Stack → Details → OpenTelemetry → *OTLP endpoint* and
     the numeric *Instance ID / User* (this endpoint also routes metrics → Mimir).
   - **Loki endpoint + user** — Stack → Details → Loki → *URL* (append `/otlp` — the collector
     sends logs via the generic `otlphttp` exporter at Loki's native OTLP ingestion path, not
     the deprecated dedicated `loki` exporter's `/loki/api/v1/push`; see #662) and its *User*.
     The OTLP and Loki instance IDs may differ but can share one token.
   - **API token** — Stack → Details → generate a token with **send metrics + send logs +
     send traces** scopes (or a service account with those permissions).

   The endpoint URLs are non-secret and live in
   `infra/kubernetes/values/{staging,production}-otel-collector.yaml` — confirm they match
   your stack's region and update them there if needed.

2. **Build the Basic-auth headers** (the collector sends these verbatim):
   ```bash
   OTLP_HEADER="Basic $(printf '%s:%s' "$OTLP_INSTANCE_ID" "$GRAFANA_TOKEN" | base64 -w0)"
   LOKI_HEADER="Basic $(printf '%s:%s' "$LOKI_INSTANCE_ID" "$GRAFANA_TOKEN" | base64 -w0)"
   ```

3. **Populate Secret Manager** for each environment (`stg` against the staging project,
   `prod` against the production project):
   ```bash
   printf '%s' "$OTLP_HEADER" | gcloud secrets versions add lifting-logbook-stg-otel-otlp-auth-header --data-file=- --project=<STAGING_PROJECT_ID>
   printf '%s' "$LOKI_HEADER" | gcloud secrets versions add lifting-logbook-stg-otel-loki-auth-header --data-file=- --project=<STAGING_PROJECT_ID>
   printf '%s' "$OTLP_HEADER" | gcloud secrets versions add lifting-logbook-prod-otel-otlp-auth-header --data-file=- --project=<PROD_PROJECT_ID>
   printf '%s' "$LOKI_HEADER" | gcloud secrets versions add lifting-logbook-prod-otel-loki-auth-header --data-file=- --project=<PROD_PROJECT_ID>
   ```
   If a container does not exist yet, create it first with
   `gcloud secrets create <name> --replication-policy=automatic --project=<project>`, then
   `versions add`. (The guided script does this for you.)

   > **Single shared stack (free tier).** Staging and production reuse the *same* Grafana Cloud
   > stack, endpoints, and token here. Because the API does not yet emit a `deployment.environment`
   > attribute, the two environments' telemetry intermix and staging 5xx can trip prod alerts —
   > tracked in [#487](https://github.com/merickvaughn/lifting-logbook/issues/487). If you later move to
   > separate stacks, give each env its own endpoints (the per-env values files) and token (the
   > per-env secrets) instead.

After the secrets are populated, the next push-to-main deploy wires telemetry end to end —
verify in Grafana Cloud: Tempo `{ service.name = "lifting-logbook-api" }`, Loki
`{ service_name = "lifting-logbook-api" }`, and the `http.server.*` metric in Mimir. The
operational runbook is [`docs/runbooks/observability.md`](runbooks/observability.md).

### Mapping a custom domain to Cloud Run

To serve the app from a custom domain (e.g. `liftinglogbook.com`), first verify domain ownership
in [Google Search Console](https://search.google.com/search-console), then create the Cloud Run
domain mapping:

```bash
gcloud beta run domain-mappings create --service=lifting-logbook-prod-web \
  --domain=liftinglogbook.com --region=us-central1 --project=lifting-logbook-prod
```

> **The verification TXT record's host field must be `@`.** When adding the Google Search Console
> TXT record for domain-ownership verification (required before `gcloud beta run
> domain-mappings create`), the **Name/host field must be `@`** (the apex). Other values — blank,
> or the full domain name — fail silently: verification never completes, and the registrar UI
> default is frequently wrong. Specify `@` explicitly rather than leaving it to the registrar's
> default or "leave blank" guidance. Validated during the `liftinglogbook.com` production setup
> (2026-05-20).

For the full walkthrough — `www` subdomain mapping, the A/AAAA/CNAME DNS records to add, and
SSL provisioning status — see [`deploy-single-user.md` Step 6](deploy-single-user.md#step-6--map-a-custom-domain-optional),
which documents the same verification gotcha and carries the rest of the procedure this summary
omits.

### Edge rate limit (Cloud Armor) — `/api/client-errors`

The unauthenticated `POST /api/client-errors` beacon sink records one retained ERROR span per
accepted request, so it needs an infra-level rate limit against scripted abuse (#808 / ADR-034). The
Terraform — an external HTTPS load balancer with a serverless NEG in front of the web Cloud Run
service, plus a Cloud Armor per-IP throttle scoped to the `/api/client-errors` path — is committed in
[`infra/terraform/edge-load-balancer.tf`](../infra/terraform/edge-load-balancer.tf) but **off by
default** (`enable_edge_load_balancer = false`), so it is a no-op plan and the app keeps serving
directly off `*.run.app`. **[#804](https://github.com/merickvaughn/lifting-logbook/issues/804) has since
landed** ([PR #814](https://github.com/merickvaughn/lifting-logbook/pull/814)), so the web runtime already
exports to the prod collector and the surface is live — enablement (tracked in
[#826](https://github.com/merickvaughn/lifting-logbook/issues/826)) now waits only on a domain / DNS cutover:

> **Prod is already served at the `liftinglogbook.com` apex + `www` via Cloud Run domain mappings**,
> not a greenfield domain — so the cutover covers **both** domains, uses a **Certificate Manager
> DNS-authorization** cert (the cert reaches `ACTIVE` while the apex/www keep serving, for a
> zero-downtime flip), and must **delete** the domain mappings before phase 2 (they are incompatible
> with the phase-2 ingress lock). This procedure is the [ADR-034 2026-07-12 amendment](adr/ADR-034-edge-rate-limiting-client-errors.md#amendment-2026-07-12-apex-and-www-already-live-zero-downtime-cert-manager-cutover);
> the code prerequisite is [#830](https://github.com/merickvaughn/lifting-logbook/issues/830).

Enabling is **two phases** (decoupled so the live domain never goes dark):

**Phase 1 — stand up the LB; the apex/www keep serving via their domain mappings throughout:**

1. Set `enable_edge_load_balancer = true`, `web_domain = "liftinglogbook.com"`,
   `web_domain_aliases = ["www.liftinglogbook.com"]` (leave `lock_web_ingress_to_lb = false`), then
   `terraform apply`. Creates the LB, Cloud Armor policy, the per-domain DNS authorizations, and the
   managed cert (`PROVISIONING`). `run.app` **and** the domain mappings are untouched.
2. `terraform output edge_lb_dns_authorizations` → at the registrar, add each domain's
   `_acme-challenge` **CNAME** (`record_name` → `record_data`). Serving is unaffected.
3. Wait for the Certificate Manager cert to reach `ACTIVE` (validates via the CNAMEs; the apex/www keep
   serving via their domain mappings — **zero impact**).
4. `terraform output edge_lb_ip` → flip the apex + `www` **A** records to that IP and remove their
   `AAAA` records (the LB is IPv4-only). Cert is already `ACTIVE` ⇒ near-zero window.
5. Verify `https://liftinglogbook.com` + `https://www.liftinglogbook.com` serve via the LB, and a burst
   above the threshold from one IP returns `429` on `/api/client-errors` (the backend service has
   request logging on, so the Cloud Armor throttle verdict is in Cloud Logging).
6. **Delete** the two Cloud Run domain mappings (now bypassed by DNS; incompatible with phase 2):
   ```bash
   gcloud beta run domain-mappings delete --domain liftinglogbook.com \
     --region us-central1 --project lifting-logbook-prod
   gcloud beta run domain-mappings delete --domain www.liftinglogbook.com \
     --region us-central1 --project lifting-logbook-prod
   ```

**Phase 2 — close the `run.app` bypass (only after phase 1 is verified):**

7. Set `lock_web_ingress_to_lb = true` and `terraform apply` — flips the web service ingress to
   `INTERNAL_AND_CLOUD_LOAD_BALANCING`. Confirm `run.app` now rejects direct public traffic while
   `https://liftinglogbook.com` still serves.

Do **not** flip `lock_web_ingress_to_lb` before the cert is `ACTIVE` and DNS is cut over — that would
lock `run.app` while the LB can't yet serve the domain and the site goes dark (a precondition also
rejects it unless the LB is enabled). Roll back in reverse: unset `lock_web_ingress_to_lb` and apply;
recreate the apex/www domain mappings and repoint their DNS
([`deploy-single-user.md` Step 6](deploy-single-user.md#step-6--map-a-custom-domain-optional) covers the
records); then unset `enable_edge_load_balancer` and apply; finally
remove the DNS-auth CNAMEs. Rationale, threshold tuning (`client_error_rate_limit_count`), and
alternatives: [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md).

### Accessing logs

```bash
# GKE
kubectl logs -n production -l app=api --tail=100

# Cloud Run
gcloud logging read "resource.type=cloud_run_revision AND \
  resource.labels.service_name=lifting-logbook-prod-api" \
  --limit=50 --project=lifting-logbook-prod
```

---

## Cost estimates

| Resource | Staging | Production | Production (single-user, `enable_gke=false`) |
|---|---|---|---|
| GKE Autopilot (1 replica × 250m CPU × 256Mi) | ~$15/mo | ~$30/mo (2 replicas) | — (skipped) |
| Cloud SQL (db-f1-micro / db-g1-small) | ~$8/mo | ~$25/mo | ~$10–25/mo (tier-dependent) |
| Cloud Run (low traffic) | ~$0–2/mo | ~$0–5/mo | ~$0–5/mo |
| Artifact Registry | <$1/mo | <$1/mo | <$1/mo |
| **Total** | **~$24/mo** | **~$61/mo** | **~$15–30/mo** |

> GKE Autopilot charges for requested pod resources, not node capacity.
> Idle pods with minimal resource requests keep costs low.
> See [GKE Autopilot pricing](https://cloud.google.com/kubernetes-engine/pricing#autopilot_mode).
