# Staging Activation Runbook

A linear top-to-bottom checklist for **activating a `lifting-logbook-staging` environment
on top of an existing production deploy**. This file cross-references the canonical
[`deploy.md`](deploy.md) for the prose; it exists so the operator does not have to
mentally filter prod-vs-staging at each step.

If you are setting up production from scratch, follow [`deploy.md`](deploy.md) instead —
it covers staging and production together. Come back here only if production is already
live and you want to add staging next.

**Pre-existing assumptions:**

- Production GCP project `lifting-logbook-prod` is bootstrapped and the deploy workflow runs
  through to production today (i.e., the "production-only" mode described in [`deploy.md` §
  Deploy modes](deploy.md#deploy-modes)).
- You already have `gcloud` authenticated, `terraform >= 1.7` installed, and a billing
  account ID handy. If not, see [`deploy.md` § Prerequisites](deploy.md#prerequisites).
- You have admin rights on the GitHub repository (to add secrets and variables) and on
  the Clerk org (to create a new application).

---

## Step 1 — Bootstrap the staging GCP project

`scripts/bootstrap-gcp.sh` is the same script used for production; `--project-id` selects
which project it operates on. It is idempotent — safe to re-run.

```bash
./scripts/bootstrap-gcp.sh XXXXXX-XXXXXX-XXXXXX \
  --project-id lifting-logbook-staging
```

Replace `XXXXXX-XXXXXX-XXXXXX` with your billing account ID
(`gcloud billing accounts list`). The script creates the project, links billing,
enables the bootstrap APIs Terraform needs, and provisions the
`lifting-logbook-staging-tfstate` bucket.

---

## Step 2 — Terraform apply (staging workspace)

Staging shares the same module as production via `var.environment`; the only difference
is the workspace and tfvars file. See [`deploy.md` § Step 3 — Bootstrap Terraform](deploy.md#step-3--bootstrap-terraform-first-apply)
for the full first-apply walkthrough (workload identity pool, Artifact Registry, IAM
bindings). The staging-specific commands:

```bash
cd infra/terraform
terraform init
terraform workspace new staging          # or `select staging` if it already exists
terraform apply -var-file=terraform.tfvars.staging
```

After apply completes, capture the outputs you will need in Step 4:

```bash
terraform output workload_identity_provider
terraform output cicd_service_account_email
```

---

## Step 3 — Create the Clerk staging app and load keys

1. In the Clerk dashboard, create a new application named **`lifting-logbook-staging`**.
   Keep it in **Development** mode — no production switch is required for staging.
2. Copy the **publishable key** (`pk_test_...`) and **secret key** (`sk_test_...`)
   from **Configure → API keys**.
3. Write them into the staging Secret Manager secrets (the secret IDs already exist
   from Step 2's Terraform apply):

```bash
echo -n "sk_test_YOUR_KEY" | gcloud secrets versions add \
  lifting-logbook-stg-clerk-secret-key --data-file=- \
  --project=lifting-logbook-staging

echo -n "pk_test_YOUR_KEY" | gcloud secrets versions add \
  lifting-logbook-stg-clerk-publishable-key --data-file=- \
  --project=lifting-logbook-staging
```

For more context (and the production half of these commands) see
[`deploy.md` § Step 4](deploy.md#step-4--sign-up-for-clerk-and-create-two-apps).

---

## Step 4 — Add GitHub repository secrets and variable

The deploy workflow gates staging on the presence of `GCP_STAGING_WORKLOAD_IDENTITY_PROVIDER`.
Until you add the three entries below, the workflow runs production-only.

```bash
# Repository secrets (masked)
gh secret set GCP_STAGING_WORKLOAD_IDENTITY_PROVIDER \
  --body "$(cd infra/terraform && terraform output -raw workload_identity_provider)"

gh secret set GCP_STAGING_SERVICE_ACCOUNT \
  --body "$(cd infra/terraform && terraform output -raw cicd_service_account_email)"

# Repository variable (NOT a secret — see deploy.md §5 "Why variables, not secrets?")
gh variable set GCP_STAGING_PROJECT_ID --body "lifting-logbook-staging"
```

Verify in **Settings → Secrets and variables → Actions** that all three entries appear.
The full secret/variable inventory (including the production counterparts) is in
[`deploy.md` § Step 5](deploy.md#step-5--add-github-repository-secrets-and-variables).

---

## Step 5 — Run migrations and seed the staging database

Run the database migrations:

```bash
./scripts/migrate-staging-db.sh
```

The migrate script temporarily enables a public IP on the staging Cloud SQL instance
for the duration of the migrate run, then removes it. The Cloud SQL Auth Proxy still
requires that IP for local connectivity, so to seed afterwards you must briefly
re-enable the public IP for the seed window.

Find the instance name and database password:

```bash
# Instance name (look for the lifting-logbook-stg-db-<suffix> row)
gcloud sql instances list --project=lifting-logbook-staging

# Database password (read once, never log it)
gcloud secrets versions access latest \
  --secret=lifting-logbook-stg-db-password \
  --project=lifting-logbook-staging
```

Re-enable the public IP, seed, then remove it again:

```bash
INSTANCE=lifting-logbook-stg-db-<suffix>

gcloud sql instances patch "$INSTANCE" \
  --assign-ip --project=lifting-logbook-staging --quiet

# Use port 5434 (avoids conflict with the prod proxy on 5433)
# sslmode=disable is required: the proxy handles TLS; Prisma must not negotiate SSL
cloud-sql-proxy --port 5434 \
  "lifting-logbook-staging:us-central1:$INSTANCE" &
PROXY_PID=$!

DATABASE_URL="postgresql://lifting-logbook-app:<password>@127.0.0.1:5434/lifting_logbook?sslmode=disable" \
  npx --prefix apps/api prisma db seed

kill "$PROXY_PID"
gcloud sql instances patch "$INSTANCE" \
  --no-assign-ip --project=lifting-logbook-staging --quiet
```

The seed script (`apps/api/prisma/seed.ts`) uses `upsert` everywhere — re-running it is
safe. It writes 12 cycles × 6 lifts of 5/3/1 data under the synthetic user
`seed_user_clerkid_staging_001`, which is not reachable via any real Clerk token.

The full table-by-table row count is documented in
[`deploy.md` § Step 3.5 — Seed staging data](deploy.md#step-35--seed-staging-data).

---

## Step 6 — Verify the full pipeline

Push a trivial commit to `main` (or merge a PR) and watch the workflow in **Actions**.
With the staging secrets in place, the pipeline runs:

```
preflight → build → deploy-staging (terraform apply + deploy, under the staging lock) → smoke-test
         → [manual approval] → terraform-production → deploy-production
```

The staging Cloud Run URL appears in the `deploy-staging` job output. Smoke-test
manually with:

```bash
curl -I https://<staging-web-url>          # expect 200 or 307
curl -I https://<staging-api-url>/health   # expect 200 or 403
```

The Nest `HealthController` is `@Public()` and returns `200`. Cloud Run's IAM layer
may return `403` first if the service is configured `--no-allow-unauthenticated`;
the workflow's smoke-test job accepts both statuses for the same reason
(`.github/workflows/deploy.yml`, "API smoke test").

If the smoke-test job fails, the production job will not run — production stays on
the previous revision. The smoke-test logic lives in `.github/workflows/deploy.yml`
(search for "Smoke test").

---

## Troubleshooting

- **Workflow still runs production-only after adding secrets.** Re-run a failed
  workflow or push a new commit — the preflight job evaluates the secrets at start.
- **`terraform apply` fails on a missing API.** The bootstrap script enables the
  two APIs Terraform itself needs (Service Usage + Cloud Resource Manager);
  Terraform enables the rest on apply. If you skipped the bootstrap script, re-run it.
- **Seed script fails with `SSL/TLS required`.** Confirm `sslmode=disable` is set
  in `DATABASE_URL`. The Cloud SQL Auth Proxy handles TLS; layering Prisma SSL on
  top causes a handshake error.

For deeper troubleshooting (CI/CD IAM errors, rollback) see
[`deploy.md` § Ongoing operations](deploy.md#ongoing-operations).
