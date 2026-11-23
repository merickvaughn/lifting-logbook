# ─── Cloud Run Services ───────────────────────────────────────────────────────
#
# Per ADR-009: Cloud Run receives 10% of traffic as the A/B comparison target.
# Metrics collected: cost per request, cold start latency, operational complexity.

locals {
  image_tag = var.image_tag
  # "bootstrap" is a sentinel used on first apply before CI/CD has pushed any images.
  # CI/CD overwrites this via gcloud run deploy; lifecycle.ignore_changes prevents Terraform
  # from reverting it on subsequent applies.
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello:latest"
  api_image         = var.image_tag == "bootstrap" ? local.placeholder_image : "${var.artifact_registry_region}-docker.pkg.dev/${var.project_id}/${var.app_name}/api:${local.image_tag}"
  web_image         = var.image_tag == "bootstrap" ? local.placeholder_image : "${var.artifact_registry_region}-docker.pkg.dev/${var.project_id}/${var.app_name}/web:${local.image_tag}"

  # Cloud Run min instances. var.cloud_run_min_instances overrides the per-environment
  # default when set (use 0 in production for scale-to-zero / single-user deploys).
  cloud_run_min_instances = var.cloud_run_min_instances != null ? var.cloud_run_min_instances : (var.environment == "production" ? 1 : 0)
}

# ─── API ──────────────────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "api" {
  name     = "${local.name_prefix}-api"
  location = var.region

  template {
    service_account = google_service_account.api_workload.email

    scaling {
      min_instance_count = local.cloud_run_min_instances
      # Single source of truth shared with the RLS pool-sizing formula (main.tf
      # local.db_connection_limit) so maxScale and connection_limit cannot drift (#517).
      max_instance_count = local.api_max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.main.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.api_image

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = var.environment == "production" ? "production" : "staging"
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      # SYSTEM_DATABASE_URL is intentionally NOT injected (#534). After the RLS
      # cutover (#517) the runtime connects as the NOBYPASSRLS lifting_app role via
      # DATABASE_URL; the SystemDbRepositoryFactory (the only reader) is constructed
      # only when DATABASE_URL is unset, which never happens on this service. The
      # owner/superuser credential bypasses RLS on every DB in the instance, so it is
      # kept out of the runtime env. The google_secret_manager_secret.system_database_url
      # resource is retained (deleting it is the destructive action; an unreferenced
      # secret has zero runtime exposure). The deploy pipeline also passes
      # --remove-secrets=SYSTEM_DATABASE_URL to strip it from the already-running
      # service, since this template is lifecycle.ignore_changes and is not reconciled.

      env {
        name = "CLERK_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.clerk_secret_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "KMS_KEY_NAME"
        value = google_kms_crypto_key.user_data_source.id
      }

      # Linking a Google Sheet (#1432, ADR-047 decisions 8-9). With no client ID the API answers
      # 503 google-sheet-unconfigured. The deploy pipeline sets these on the live service too, and
      # sets GOOGLE_OAUTH_REDIRECT_URI: from the web service's run.app URL in staging (set here, it
      # would be a cycle), and from the custom domain, liftinglogbook.com, in production.
      env {
        name  = "GOOGLE_OAUTH_CLIENT_ID"
        value = var.google_oauth_client_id
      }

      env {
        name = "GOOGLE_OAUTH_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_oauth_client_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "GOOGLE_OAUTH_TOKEN_KMS_KEY_NAME"
        value = google_kms_crypto_key.google_oauth_token.id
      }

      # Point the API's OTel SDK (apps/api/src/otel.ts) at the otel-collector
      # sidecar co-located in the same Cloud Run instance (#768). The sidecar is
      # injected at deploy time by scripts/inject-otel-sidecar.py (describe →
      # inject → `gcloud run services replace`) and listens on localhost:4318,
      # forwarding to Grafana Cloud. Declared here for spec accuracy and
      # first-apply/bootstrap; because this service is
      # lifecycle.ignore_changes = [template], the live value is actually set in
      # the injected manifest by that deploy step, exactly like the sidecar itself.
      env {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = "http://localhost:4318"
      }
    }
  }

  # Image and template updates are managed exclusively by the CI/CD deploy jobs (gcloud run
  # deploy for web; `gcloud run services replace` for the api since #768).
  # Terraform creates the service on first apply; subsequent image/env/scale changes
  # are applied by the deploy-staging / deploy-production jobs, not Terraform.
  #
  # `client` and `client_version` are set by `gcloud run deploy` (e.g.,
  # "gcloud" / "568.0.0"). Without ignoring them, terraform sees them as drift
  # and tries to revert to null on the next apply. The revert triggers an
  # in-place Service modification, which Cloud Run validates by re-attempting
  # to start the current template's image. If that image is broken (e.g., a
  # bad deploy that pre-dates the current commit), the modification fails
  # with "container failed to start", blocking every subsequent terraform
  # apply even though the live image issue is unrelated to terraform.
  lifecycle {
    ignore_changes = [template, client, client_version]
  }

  depends_on = [google_project_service.required_apis]
}

# ─── OTel Collector sidecar config (#768) ────────────────────────────────────
#
# The collector's config.yaml is mounted into the otel-collector sidecar on the
# api service at /etc/otelcol/config.yaml. Cloud Run mounts config *files* from
# Secret Manager (there is no ConfigMap volume on Cloud Run), so the pipeline config
# lives in the Secret Manager secret `<name_prefix>-otel-collector-config`.
#
# That secret is intentionally NOT Terraform-managed. It is created and versioned by
# the api Cloud Run deploy step (.github/workflows/deploy.yml → "Deploy API + OTel
# Collector sidecar to Cloud Run") straight from the repo file
# infra/cloud-run/otel-collector-config.yaml, then mounted onto the injected sidecar by
# that same step. Three reasons, mirroring the OTel
# auth-header secrets handled out-of-band above in main.tf:
#   1. Declaring it here would 409 against the pipeline-created secret.
#   2. This service is lifecycle.ignore_changes = [template], so Terraform cannot
#      wire the sidecar onto the running revision anyway — the deploy step owns the
#      whole sidecar (containers, env, mounts), so the secret belongs with it.
#   3. The content is non-sensitive and fully derived from a repo file (no operator
#      token, unlike the Grafana auth headers), so CI can create + version it with no
#      human step; the pipeline adds a new version only when the file's content changes.
#
# No extra IAM: the sidecar runs as the api workload SA, which already holds a
# project-level roles/secretmanager.secretAccessor grant (gke.tf api_workload_roles),
# so it can read this secret and the two auth-header secrets with no per-secret binding.

# ─── Web ──────────────────────────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "web" {
  name     = "${local.name_prefix}-web"
  location = var.region

  # Phase 2 of enabling the edge rate limit (#808 / ADR-034): lock ingress to the
  # load balancer + internal traffic so the public *.run.app URL cannot bypass the
  # rate limit. This is a SEPARATE flag from enable_edge_load_balancer (which creates
  # the LB) and must be flipped only AFTER the LB is serving and its managed cert is
  # ACTIVE — otherwise run.app is locked while the LB can't yet serve HTTPS and the
  # site goes dark. null (the default) leaves Cloud Run's INGRESS_TRAFFIC_ALL
  # untouched, so this is a no-op until the flag is flipped. `ingress` is a top-level
  # field, outside the template that lifecycle.ignore_changes covers, so Terraform
  # manages it normally. See the ADR-034 two-phase enable procedure.
  ingress = var.lock_web_ingress_to_lb ? "INTERNAL_AND_CLOUD_LOAD_BALANCING" : null

  template {
    service_account = google_service_account.web_workload.email

    scaling {
      min_instance_count = local.cloud_run_min_instances
      max_instance_count = var.environment == "production" ? 10 : 3
    }

    containers {
      image = local.web_image

      ports {
        container_port = 3001
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      env {
        name  = "NODE_ENV"
        value = var.environment == "production" ? "production" : "staging"
      }

      env {
        name  = "API_URL"
        value = google_cloud_run_v2_service.api.uri
      }

      # Browser-facing API URL injected at runtime into window.__PUBLIC_CONFIG__
      # (#396 / ADR-028). On Cloud Run the browser reaches the same external API URL
      # as the server, so PUBLIC_API_URL == API_URL.
      env {
        name  = "PUBLIC_API_URL"
        value = google_cloud_run_v2_service.api.uri
      }

      # Runtime public config (#396 / ADR-028): consumed by the root layout and passed
      # to <ClerkProvider> as a prop — no longer NEXT_PUBLIC_ / bundle-inlined, which is
      # what restores the single build-once / promote-everywhere web image.
      env {
        name = "CLERK_PUBLISHABLE_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.clerk_publishable_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "CLERK_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.clerk_secret_key.secret_id
            version = "latest"
          }
        }
      }

      # Point the web server runtime's OTel SDK (@vercel/otel, apps/web/instrumentation.ts)
      # at the otel-collector sidecar co-located in the same Cloud Run instance (#804),
      # mirroring the api service. The sidecar is injected at deploy time by
      # scripts/inject-otel-sidecar.py (describe → inject → `gcloud run services replace`)
      # and listens on localhost:4318, forwarding to Grafana Cloud. Declared here for spec
      # accuracy and first-apply/bootstrap; because this service is
      # lifecycle.ignore_changes = [template], the live value is set by that deploy step in
      # the injected manifest, exactly like the sidecar itself. Unlike the api sidecar (which
      # runs as the api workload SA's project-level secretmanager.secretAccessor), the web
      # sidecar runs as the web workload SA and is granted read on only the three otel secrets
      # it needs — that least-privilege grant is applied by the web deploy step, not here
      # (all three secrets are pipeline/operator-managed out-of-band; see deploy.yml).
      env {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = "http://localhost:4318"
      }

      # Same-origin guard for POST /api/client-errors (#806/#809). Declared here for spec
      # accuracy + first-apply/bootstrap only; exactly like OTEL_EXPORTER_OTLP_ENDPOINT above,
      # the LIVE values are set by the web deploy step
      # (.github/actions/deploy-cloud-run-otel-sidecar with client_error_guard=true), which
      # derives CLIENT_ERROR_ALLOWED_ORIGINS from this service's own status.url and sets the
      # drop flag. Because this service is lifecycle.ignore_changes = [template], Terraform never
      # overwrites them. The empty allowlist + drop=false here is the safe observe-only default a
      # bare `terraform apply` would bootstrap — the guard never drops without an allowlist. See
      # the ADR-020 #806 addendum.
      env {
        name  = "CLIENT_ERROR_ALLOWED_ORIGINS"
        value = ""
      }
      env {
        name  = "CLIENT_ERROR_DROP_CROSS_ORIGIN"
        value = "false"
      }
    }
  }

  # Image and template updates managed by CI/CD (see lifecycle note on api service above).
  # client and client_version are also ignored for the same reason as the api service:
  # gcloud run deploy sets these on each CI deploy and Terraform would otherwise attempt
  # an in-place modification (creating a new revision) on every subsequent apply.
  lifecycle {
    ignore_changes = [template, client, client_version]

    # Phase-2 guard (#808 / ADR-034): locking web ingress to the LB before the LB
    # exists would take the public site down, so lock_web_ingress_to_lb requires
    # enable_edge_load_balancer. Holds on the committed tfvars (both default false).
    precondition {
      condition     = !var.lock_web_ingress_to_lb || var.enable_edge_load_balancer
      error_message = "lock_web_ingress_to_lb = true requires enable_edge_load_balancer = true — locking web ingress to the load balancer before the LB exists would take the site down (see the ADR-034 two-phase enable procedure)."
    }
  }

  depends_on = [
    google_project_service.required_apis,
    google_cloud_run_v2_service.api,
    google_secret_manager_secret_iam_member.web_workload_clerk_secret_key,
  ]
}

# ─── Cloud Run workload identities ────────────────────────────────────────────

resource "google_service_account" "web_workload" {
  account_id   = "${local.name_prefix}-web-wi"
  display_name = "${var.app_name} web workload identity (${var.environment})"
}

# ─── Access control ───────────────────────────────────────────────────────────
#
# Both services are publicly invokable at the Cloud Run IAM layer; Clerk JWT
# verification (apps/api/src/auth/auth.guard.ts) is the real authorization
# boundary, identical to how the web service has always worked. This is a
# deliberate reversal of the original "API requires Cloud Run IAM auth" model
# (ADR-032): ADR-028 wires PUBLIC_API_URL to the API's external Cloud Run URL
# so browsers call it directly, which structurally cannot present a Cloud Run
# IAM identity token (CORS preflights never carry the app's auth headers) —
# see apps/web/lib/client-api.ts's "AUTH HEADER INVARIANT" comment. Without
# this grant, every client-side write (reschedule, skip/unskip, lift records,
# imports, ...) 403s at the Cloud Run front end before reaching the app.
#
# web_invoker_on_api is kept even though it's no longer strictly required for
# access — the web workload SA still presents a real GCP identity token on its
# server-to-server calls (X-Clerk-Authorization carries the Clerk JWT
# separately), which is harmless and gives that traffic a distinct IAM audit
# trail from anonymous callers.
# See: https://cloud.google.com/run/docs/authenticating/public

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = google_cloud_run_v2_service.web.project
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "api_public" {
  project  = google_cloud_run_v2_service.api.project
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "web_invoker_on_api" {
  project  = google_cloud_run_v2_service.api.project
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.web_workload.email}"
}

resource "google_secret_manager_secret_iam_member" "web_workload_publishable_key" {
  secret_id = google_secret_manager_secret.clerk_publishable_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_workload.email}"
}

resource "google_secret_manager_secret_iam_member" "web_workload_clerk_secret_key" {
  secret_id = google_secret_manager_secret.clerk_secret_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.web_workload.email}"
}

# ─── Serverless VPC Connector (private Cloud SQL access from Cloud Run) ───────

resource "google_vpc_access_connector" "main" {
  name          = "${local.env_suffix}-connector"
  region        = var.region
  network       = google_compute_network.main.name
  ip_cidr_range = var.environment == "production" ? "10.8.0.0/28" : "10.8.1.0/28"
  depends_on    = [google_project_service.required_apis]
}

# ─── Database migration job (ADR-027) ─────────────────────────────────────────
#
# Cloud Run Job that runs `prisma migrate deploy` against the environment's
# Cloud SQL database. The database has a private IP only, so a GitHub-hosted
# runner cannot reach it directly — this job runs *inside* the VPC via the same
# serverless connector the API service uses, then the deploy pipeline executes
# it (gcloud run jobs execute --wait) before the API revision goes live. A
# failed migration therefore fails the deploy and the last-good API revision
# keeps serving. Before this job existed, migrations were never applied by the
# pipeline (only ci.yml ran `migrate deploy`, against the CI test DB), so prod
# schema drifted silently and any endpoint touching a missing table 500'd
# (#458 / #460). See ADR-027.
#
# The container reuses the API image (it already ships the Prisma CLI,
# @prisma/engines, and the migrations under apps/api/prisma) and overrides the
# entrypoint to run migrations instead of the server. It runs as the API
# workload SA, which already holds roles/cloudsql.client and
# roles/secretmanager.secretAccessor (see api_workload_roles in gke.tf).
resource "google_cloud_run_v2_job" "migrate" {
  name     = "${local.name_prefix}-migrate"
  location = var.region

  template {
    template {
      service_account = google_service_account.api_workload.email

      # A migration must run exactly once. A retry of a half-applied migration
      # leaves a failed row in _prisma_migrations that Prisma refuses to step
      # past anyway, so retrying cannot help — fail fast and surface it.
      max_retries = 0

      vpc_access {
        connector = google_vpc_access_connector.main.id
        egress    = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image = local.api_image

        # The API image WORKDIR is /app/apps/api, so the schema path is
        # relative to it. `migrate deploy` applies only pending migrations in
        # order (idempotent); `migrate status` then asserts a clean end-state,
        # so a non-zero exit (failed apply or leftover pending migration) fails
        # the job and, via `--wait`, the deploy.
        command = ["/bin/sh", "-c"]
        args = [
          "npx prisma migrate deploy --schema=prisma/schema.prisma && npx prisma migrate status --schema=prisma/schema.prisma"
        ]

        # Migrator connection (#517): connects as the owner/superuser role via the
        # dedicated migrator secret, NOT the runtime database_url (which now connects as
        # the NOBYPASSRLS lifting_app role). Migrations run DDL + data migrations that
        # FORCE ROW LEVEL SECURITY would otherwise block.
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.migrator_database_url.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  # The real image tag is set by the deploy pipeline via `gcloud run jobs
  # update --image` (Terraform applies with image_tag=bootstrap → placeholder).
  # Unlike the services — which ignore the whole `template` because gcloud run
  # deploy mutates many fields — the job's image is the only field gcloud
  # touches, so we ignore *only* the image and keep command/env/SA/VPC under
  # Terraform's control (changeable via a normal apply). client/client_version
  # are set by gcloud and would otherwise read as perpetual drift.
  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.required_apis]
}

# ─── Snapshot expiry job (#1309, ADR-044) ─────────────────────────────────────
#
# Deletes data_snapshot rows past their 30-day expiry. The API has no scheduler,
# so .github/workflows/expire-snapshots.yml executes this job daily, the way the
# deploy pipeline executes the migrate job. It reuses the API image and that
# job's VPC access, service account and migrator connection: row-level security
# lets only the table's owner, the migrator, see and delete expired rows (see
# the data_snapshot migration). The script refuses to run as any other role and
# fails if an expired row is left, so a failed run shows in the workflow.
resource "google_cloud_run_v2_job" "expire_snapshots" {
  name     = "${local.name_prefix}-expire-snapshots"
  location = var.region

  template {
    template {
      service_account = google_service_account.api_workload.email

      # Deleting expired rows is idempotent, so a transient failure (a dropped
      # connection) retries once; past that the run fails and the next day's
      # tries again. Reads already treat expired rows as gone.
      max_retries = 1

      vpc_access {
        connector = google_vpc_access_connector.main.id
        egress    = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image = local.api_image

        # The API image WORKDIR is /app/apps/api; nest build emits the script
        # from src/snapshots into dist/snapshots.
        command = ["node"]
        args    = ["dist/snapshots/expire-snapshots.job.js"]

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.migrator_database_url.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }
    }
  }

  # As for the migrate job: the deploy pipeline sets the image with
  # `gcloud run jobs update --image`, and everything else stays under Terraform.
  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.required_apis]
}
