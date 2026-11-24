terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.11"
    }
  }

  # Remote state in GCS — bucket is created during bootstrap (see docs/deploy.md)
  backend "gcs" {
    bucket = "lifting-logbook-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

locals {
  env_suffix  = var.environment == "production" ? "prod" : "stg"
  name_prefix = "${var.app_name}-${local.env_suffix}"

  # ─── Prisma connection-pool sizing for the RLS cutover (#517) ────────────────
  # Cap per-instance Prisma pool so the aggregate across every app instance stays
  # well under Cloud SQL max_connections (which is the tier default — not a flag —
  # so it is verified against `SHOW max_connections` at the staging gate before prod):
  #   db-f1-micro (staging) ≈ 25 ; db-g1-small (prod) ≈ 50.
  # api_max_instances is the single source of truth for the Cloud Run API maxScale:
  # google_cloud_run_v2_service.api.scaling.max_instance_count references this local
  # (cloud-run.tf), so the scaling cap and this pool-sizing formula cannot drift apart.
  # consumer_factor: staging runs BOTH Cloud Run and the GKE A/B deployment
  # (ADR-009) against the same DATABASE_URL, so it shares the pool ×2; prod is
  # Cloud-Run-only (enable_gke=false). The 0.8 factor reserves headroom for the
  # migrator job, the system DB, and the superuser-reserved connections.
  api_max_instances   = var.environment == "production" ? 10 : 3
  db_max_connections  = var.environment == "production" ? 50 : 25
  db_consumer_factor  = var.environment == "production" ? 1 : 2
  db_connection_limit = floor(local.db_max_connections * 0.8 / (local.api_max_instances * local.db_consumer_factor))
}

# ─── GCP APIs ────────────────────────────────────────────────────────────────

resource "google_project_service" "required_apis" {
  for_each = toset([
    "container.googleapis.com",         # GKE
    "run.googleapis.com",               # Cloud Run
    "sqladmin.googleapis.com",          # Cloud SQL
    "cloudkms.googleapis.com",          # Cloud KMS (ADR-014)
    "cloudtasks.googleapis.com",        # Supplement sheet mirror queue (ADR-047)
    "sheets.googleapis.com",            # Supplement sheet mirror (ADR-047)
    "artifactregistry.googleapis.com",  # Artifact Registry
    "compute.googleapis.com",           # VPC, Load Balancer
    "servicenetworking.googleapis.com", # Private service networking (Cloud SQL)
    "secretmanager.googleapis.com",     # Secret Manager
    "vpcaccess.googleapis.com",         # Serverless VPC Access (Cloud Run connector)
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])

  project                    = var.project_id
  service                    = each.value
  disable_dependent_services = false
  disable_on_destroy         = false
}

# GCP API enablement is eventually consistent — wait for propagation before
# creating any resources that depend on newly-enabled APIs.
# 60s was observed sufficient on fresh projects in testing; vpcaccess propagation
# can occasionally take longer. This only fires on create (first apply), not on
# re-applies where the APIs are already enabled.
resource "time_sleep" "api_propagation" {
  depends_on      = [google_project_service.required_apis]
  create_duration = "60s"
}

# ─── VPC ─────────────────────────────────────────────────────────────────────

resource "google_compute_network" "main" {
  name                    = "${local.name_prefix}-vpc"
  auto_create_subnetworks = false
  depends_on              = [time_sleep.api_propagation]
}

resource "google_compute_subnetwork" "main" {
  name          = "${local.name_prefix}-subnet"
  ip_cidr_range = var.environment == "production" ? "10.0.0.0/20" : "10.1.0.0/20"
  region        = var.region
  network       = google_compute_network.main.id

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.environment == "production" ? "10.48.0.0/14" : "10.52.0.0/14"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.environment == "production" ? "10.52.0.0/20" : "10.56.0.0/20"
  }

  private_ip_google_access = true
}

# Cloud NAT for GKE node egress (required for Autopilot private nodes). Gated on
# enable_gke (#860): Cloud Run reaches Cloud SQL over private VPC peering and sends
# public traffic via its own managed egress (vpc_access egress = PRIVATE_RANGES_ONLY),
# so with GKE disabled nothing traverses the NAT and it is pure idle cost (~$32/mo/env).
resource "google_compute_router" "main" {
  count   = var.enable_gke ? 1 : 0
  name    = "${local.name_prefix}-router"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  count                              = var.enable_gke ? 1 : 0
  name                               = "${local.name_prefix}-nat"
  router                             = google_compute_router.main[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# ─── Private Service Access (Cloud SQL) ──────────────────────────────────────

resource "google_compute_global_address" "private_ip_range" {
  name          = "${local.name_prefix}-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_range.name]
  depends_on              = [google_project_service.required_apis]
}

# ─── Cloud SQL (Postgres 15) ──────────────────────────────────────────────────

resource "random_id" "db_suffix" {
  byte_length = 4
}

resource "google_sql_database_instance" "main" {
  name             = "${local.name_prefix}-db-${random_id.db_suffix.hex}"
  database_version = "POSTGRES_15"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = var.db_availability_type # default ZONAL; set REGIONAL in tfvars for HA (#860)
    disk_autoresize   = true
    disk_size         = 10

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.environment == "production"
      transaction_log_retention_days = var.environment == "production" ? 7 : 1
      backup_retention_settings {
        retained_backups = var.environment == "production" ? 7 : 2
      }
    }

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.main.id
      enable_private_path_for_google_cloud_services = true
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }

  deletion_protection = var.environment == "production"
  depends_on          = [google_service_networking_connection.private_vpc_connection]
}

resource "google_sql_database" "app" {
  name     = var.db_name
  instance = google_sql_database_instance.main.name
}

resource "google_sql_database" "system" {
  name     = "${var.db_name}_system"
  instance = google_sql_database_instance.main.name
}

resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  name     = "${var.app_name}-app"
  instance = google_sql_database_instance.main.name
  password = random_password.db_password.result
}

# ─── Runtime (NOBYPASSRLS) application role — RLS cutover (#517) ───────────────
# google_sql_user.app above is a Cloud SQL built-in user and therefore a member of
# cloudsqlsuperuser, which BYPASSES Row-Level Security — so the policies shipped in
# migration 20260611000000_enable_rls are inert while the app connects as that role.
# This second role connects the *runtime* (Cloud Run + GKE) as a NOSUPERUSER /
# NOBYPASSRLS login so the per-tenant policies actually enforce isolation. The
# *migrator* (Cloud Run Job) keeps using google_sql_user.app — migrations run DDL and
# data-migrations that RLS would otherwise block (FORCE ROW LEVEL SECURITY).
#
# The "lifting_app" role itself is created idempotently by the enable_rls migration
# (with no password — none is in version control); Terraform owns only its password.
# CONTINGENCY: because the SQL migration may have already created the role, the first
# `terraform apply` per workspace can need a one-time
#   terraform import google_sql_user.app_rls "<project>/<instance>/lifting_app"
# before apply, so Terraform adopts the existing role instead of failing to re-create it.
resource "random_password" "app_rls_password" {
  length  = 32
  special = false
}

resource "google_sql_user" "app_rls" {
  name     = "lifting_app"
  instance = google_sql_database_instance.main.name
  password = random_password.app_rls_password.result
}

# ─── Secret Manager ──────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "database_url" {
  secret_id = "${local.name_prefix}-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required_apis]
}

# Runtime DATABASE_URL — connects as the NOBYPASSRLS lifting_app role (#517) so RLS
# policies enforce, and caps the Prisma pool via ?connection_limit so the aggregate
# across all app instances stays under Cloud SQL max_connections. The migrate Job uses
# a SEPARATE secret (migrator_database_url, below) that still connects as the owner.
resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${google_sql_user.app_rls.name}:${random_password.app_rls_password.result}@${google_sql_database_instance.main.private_ip_address}:5432/${var.db_name}?connection_limit=${local.db_connection_limit}"
}

resource "google_secret_manager_secret" "system_database_url" {
  secret_id = "${local.name_prefix}-system-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required_apis]
}

resource "google_secret_manager_secret_version" "system_database_url" {
  secret      = google_secret_manager_secret.system_database_url.id
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db_password.result}@${google_sql_database_instance.main.private_ip_address}:5432/${var.db_name}_system"
}

# Migrator DATABASE_URL — used ONLY by the migrate Cloud Run Job (#517). Connects as
# the owner/superuser role (google_sql_user.app), which can run DDL and data migrations
# that RLS would otherwise block. No connection_limit: the job runs once with a single
# connection. The api workload SA already holds project-level secretmanager.secretAccessor
# (gke.tf api_workload_roles), so no per-secret IAM grant is required.
resource "google_secret_manager_secret" "migrator_database_url" {
  secret_id = "${local.name_prefix}-migrator-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required_apis]
}

resource "google_secret_manager_secret_version" "migrator_database_url" {
  secret      = google_secret_manager_secret.migrator_database_url.id
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db_password.result}@${google_sql_database_instance.main.private_ip_address}:5432/${var.db_name}"
}

resource "google_secret_manager_secret" "clerk_secret_key" {
  secret_id = "${local.name_prefix}-clerk-secret-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required_apis]
}

# Placeholder — value populated manually after Clerk app creation (see docs/deploy.md)
resource "google_secret_manager_secret_version" "clerk_secret_key" {
  secret      = google_secret_manager_secret.clerk_secret_key.id
  secret_data = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret" "clerk_publishable_key" {
  secret_id = "${local.name_prefix}-clerk-publishable-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required_apis]
}

resource "google_secret_manager_secret_version" "clerk_publishable_key" {
  secret      = google_secret_manager_secret.clerk_publishable_key.id
  secret_data = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# The Google OAuth client secret for linking a sheet (#1432, ADR-047 decision 9).
resource "google_secret_manager_secret" "google_oauth_client_secret" {
  secret_id = "${local.name_prefix}-google-oauth-client-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required_apis]
}

# Placeholder — value populated manually after the Google OAuth client is created (see docs/deploy.md)
resource "google_secret_manager_secret_version" "google_oauth_client_secret" {
  secret      = google_secret_manager_secret.google_oauth_client_secret.id
  secret_data = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# ── OTel Collector → Grafana Cloud auth headers (#474) ───────────────────────
# These are intentionally NOT Terraform-managed. Unlike the Clerk/DB secrets
# (created once at initial bootstrap), the OTel auth headers are created and
# populated together by scripts/bootstrap-otel-secrets.sh — the operator never
# wants a REPLACE_ME placeholder version to exist (the deploy's sync step would
# fail on it), and declaring them here would 409 against the script-created
# secrets on the next `terraform apply`. The deploy pipeline reads them with the
# CI/CD SA (roles/owner already grants secretAccessor) and syncs them into the
# otel-collector-secrets k8s Secret. Secret names:
#   ${name_prefix}-otel-otlp-auth-header   (traces + metrics → Tempo/Mimir)
#   ${name_prefix}-otel-loki-auth-header   (logs → Loki)

# ─── Cloud KMS (ADR-014 — credential encryption at rest) ─────────────────────

resource "google_kms_key_ring" "main" {
  name       = "${local.name_prefix}-keyring"
  location   = var.region
  depends_on = [google_project_service.required_apis]
}

resource "google_kms_crypto_key" "user_data_source" {
  name            = "user-data-source-kek"
  key_ring        = google_kms_key_ring.main.id
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

# The supplement sheet mirror's Google refresh tokens (#1432, ADR-047 decision 8). Its own key, so
# disabling or rotating it touches only google_sheet_link.
resource "google_kms_crypto_key" "google_oauth_token" {
  name            = "google-oauth-token-kek"
  key_ring        = google_kms_key_ring.main.id
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

# ─── Artifact Registry ───────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "images" {
  repository_id = var.app_name
  location      = var.artifact_registry_region
  format        = "DOCKER"
  description   = "Container images for ${var.app_name}"

  # Bound image-storage growth (#860). CI pushes new api + web tags (:<sha>, :latest,
  # :pr-N) on every PR/merge with no prior retention, so blobs accumulated unbounded
  # (hundreds of MB per image). Keep the 10 most-recent versions per package as rollback
  # targets; delete anything older than 30 days that the KEEP policy does not protect.
  # KEEP always takes precedence over DELETE, so the current/recent images are never
  # pruned regardless of age.
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-recent-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-stale"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days
    }
  }

  depends_on = [google_project_service.required_apis]
}

# No cross-project Artifact Registry reader grants (#397 / ADR-029). Each
# environment's images are now pushed directly to that environment's AR by
# build-images (.github/workflows/deploy.yml) — the prod SA re-auths and
# build-pushes straight to the prod AR rather than copying from the staging AR
# via `docker buildx imagetools create`, so it no longer needs reader access on
# the staging AR. The previous `external_readers` member and its
# `external_ar_reader_service_accounts` variable were removed; applying this
# revokes the standing cross-project grant.

# ─── Artifact Registry — Docker Hub pull-through mirror (#795) ────────────────

# The otel-collector image (otel/opentelemetry-collector-contrib) is pulled from
# Docker Hub by a mutable tag on every Cloud Run cold-start / GKE node pull, so a
# Docker Hub rate-limit (100 pulls/6h per IP) or outage can fail new production
# request-path instances, and a re-pushed tag breaks reproducibility (#788/#795).
# This REMOTE repository proxies Docker Hub through Artifact Registry: the first
# pull of a given digest fetches upstream and caches it in-project; every later
# request-path pull is served from AR (in-GCP, no Docker Hub dependency).
# Consumers reference it by digest — wired in the #795 follow-up PR.
resource "google_artifact_registry_repository" "dockerhub_mirror" {
  repository_id = "${var.app_name}-dockerhub"
  location      = var.artifact_registry_region
  format        = "DOCKER"
  mode          = "REMOTE_REPOSITORY"
  description   = "Docker Hub pull-through cache for ${var.app_name} (otel-collector, #795)"

  remote_repository_config {
    description = "Docker Hub"
    docker_repository {
      public_repository = "DOCKER_HUB"
    }
  }

  depends_on = [google_project_service.required_apis]
}

# Project number for the image-pull identities' service-account emails.
data "google_project" "current" {}

# Explicit reader on the mirror for the two identities that pull container images.
# Pulls from the STANDARD `images` repo above rely on Google's implicit project-
# level grant, but the first-ever pull-through of this REMOTE repo happens on a
# production/staging deploy that PR CI does not exercise (staging.yml deploys the
# api without the sidecar; the collector ships only via deploy.yml on push:main),
# so grant reader explicitly rather than depend on the implicit bind:
#   * Cloud Run pulls the sidecar image via its service agent (serverless-robot).
#   * GKE Autopilot nodes pull the DaemonSet image via the default Compute SA.
resource "google_artifact_registry_repository_iam_member" "dockerhub_mirror_readers" {
  for_each = toset([
    "serviceAccount:service-${data.google_project.current.number}@serverless-robot-prod.iam.gserviceaccount.com",
    "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com",
  ])
  location   = google_artifact_registry_repository.dockerhub_mirror.location
  repository = google_artifact_registry_repository.dockerhub_mirror.name
  role       = "roles/artifactregistry.reader"
  member     = each.value
}

# ─── IAM — CI/CD service account ─────────────────────────────────────────────

resource "google_service_account" "cicd" {
  account_id   = "${local.name_prefix}-cicd"
  display_name = "${var.app_name} CI/CD (${var.environment})"
}

resource "google_project_iam_member" "cicd_roles" {
  for_each = toset([
    # The CI/CD service account is the trusted automation identity for
    # this project — it runs `terraform apply` and `gcloud run deploy`
    # for every push to main. For a single-user production project,
    # granting Owner is the pragmatic choice:
    #
    #   * Editor + projectIamAdmin still excludes `setIamPolicy` on
    #     several resource types (Secret Manager secrets, KMS keys,
    #     storage buckets) that Terraform's `*_iam_member` resources
    #     need to manage. Closing each gap individually with a
    #     resource-specific admin role is a whack-a-mole pattern that
    #     this module has already iterated through twice (#301, #303).
    #   * Owner gives the SA the same authority the human operator
    #     already has when they run the first local terraform apply.
    #     The only thing Owner adds beyond Editor+projectIamAdmin that
    #     a deploy automation arguably should not have is the ability
    #     to delete the project itself — acceptable here because access
    #     to the SA is gated by WIF (only this repo's main branch).
    #
    # For multi-tenant production projects, replace `owner` with a
    # narrower combination (e.g., editor + projectIamAdmin +
    # secretmanager.admin + cloudkms.admin + storage.admin) and accept
    # that adding new resource types may require adding more roles.
    "roles/owner",

    # Identity-token issuance for workload identity is not in `owner`.
    "roles/iam.serviceAccountTokenCreator",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cicd.email}"
}

# TF state bucket IAM is managed out-of-band, not by Terraform.
# The bucket (lifting-logbook-prod-tfstate) lives in the lifting-logbook-prod GCP project.
# Neither SA can manage IAM on a cross-project bucket from within their own CI/CD context.
# Both SAs are granted roles/storage.objectAdmin via a one-time gcloud command (see docs/deploy.md §2).
#
# The removed block below drops the previously-tracked IAM binding from Terraform state
# without issuing a delete call, so existing grants are preserved.
removed {
  from = google_storage_bucket_iam_member.cicd_tfstate
  lifecycle {
    destroy = false
  }
}

# ─── IAM — Workload Identity Federation (keyless auth for GitHub Actions) ────

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.name_prefix}-github-pool"
  display_name              = "GitHub Actions (${var.environment})"
  depends_on                = [google_project_service.required_apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub OIDC"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  # google.subject is deliberately NOT assertion.sub (#869). Under merge_group,
  # GitHub's `sub` embeds the merge queue's synthetic ref
  # (repo:<owner>/<repo>:ref:refs/heads/gh-readonly-queue/main/pr-<N>-<40-char-sha>),
  # which overflows Google's 127-byte mapped-attribute limit and fails the exchange
  # with `invalid_request`. No pull_request/push ref comes close, so the mapping was
  # latent-broken until the merge queue went live and dropped the first queued PR.
  # assertion.repository is constant-length and safely bounded. No ACCESS depends on
  # the subject: both SA bindings below authorize via principalSet on
  # attribute.repository, and no principal://.../subject/... binding exists anywhere.
  #
  # AUDIT granularity is knowingly traded away, however. Cloud Audit Logs derive the
  # federated principal from google.subject, so every run — whatever the actor — now
  # authenticates as one constant subject, and a staging apply can no longer be
  # attributed to the actor or PR that triggered it. attribute.actor does NOT recover
  # this: it is usable in IAM conditions and principalSet members, but it is not the
  # identifier logged as the principal. A bounded composite
  # ("assertion.repository + '/' + assertion.actor") would restore attribution while
  # staying far under 127 bytes; it is deliberately NOT taken here because this change
  # is the fix for a live auth outage and re-shaping the subject a second time would
  # put an unproven value in the critical path. Tracked in #874.
  attribute_mapping = {
    "google.subject"       = "assertion.repository"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
  }

  attribute_condition = "assertion.repository == '${var.github_repository}'"
}

resource "google_service_account_iam_member" "cicd_wif_binding" {
  service_account_id = google_service_account.cicd.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

# ─── IAM — read-only plan service account (#545) ─────────────────────────────
#
# A least-privilege identity for the read-only `plan-production` CI job, which
# runs `terraform plan` against prod on every merge to surface the blast radius
# before the production approval gate (#542 / #544). It deliberately lacks the
# write/apply authority of `cicd` (roles/owner): it can refresh state and read,
# including every resource's IAM policy, but cannot mutate prod or change IAM.
#
# Caveat — this is NOT a zero-secret identity. Prod manages
# google_secret_manager_secret_version resources (database_url, clerk keys, …),
# and `terraform plan` refreshes them by reading the version payload — which
# roles/viewer does not grant, hence roles/secretmanager.secretAccessor below.
# So this SA can still READ prod secret values during a plan refresh; it simply
# cannot write anything. A truly secretless plan is not achievable while the
# config manages secret versions in state.
#
# Created in both workspaces for parity; currently consumed only by prod's
# plan-production job (the staging copy is unused — there is no plan-staging
# job). The CI cutover that points plan-production at this SA lands separately
# (#545 Phase 2), after the SA exists in prod and its secret is set.
resource "google_service_account" "cicd_plan" {
  account_id   = "${local.name_prefix}-plan"
  display_name = "${var.app_name} CI/CD plan, read-only (${var.environment})"
}

resource "google_project_iam_member" "cicd_plan_roles" {
  for_each = toset([
    # Broad read for `terraform plan` to refresh every managed resource.
    "roles/viewer",
    # Required so plan can refresh google_secret_manager_secret_version
    # resources (roles/viewer covers metadata but not versions.access). See
    # the caveat above — this is the one grant that lets the SA read secrets.
    "roles/secretmanager.secretAccessor",
    # Refreshing a resource-level *_iam_member reads that resource's IAM policy, and
    # roles/viewer lacks some of those reads: cloudtasks.queues.getIamPolicy (the
    # sheet-mirror queue's enqueuer grant, #1460) and storage.buckets.getIamPolicy (the
    # staging-only ci-locks bucket). Security Reviewer holds every getIamPolicy plus get/list
    # permissions and nothing that sets, creates, updates or deletes, so it covers the next
    # such resource too. https://docs.cloud.google.com/iam/docs/roles-permissions/iam#iam.securityReviewer
    "roles/iam.securityReviewer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cicd_plan.email}"
}

resource "google_service_account_iam_member" "cicd_plan_wif_binding" {
  service_account_id = google_service_account.cicd_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}
