variable "project_id" {
  description = "GCP project ID (created manually during bootstrap)"
  type        = string
}

variable "billing_account" {
  description = "GCP billing account ID (format: XXXXXX-XXXXXX-XXXXXX)"
  type        = string
}

variable "region" {
  description = "Primary GCP region"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Deployment environment: staging or production"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "app_name" {
  description = "Application name, used as a prefix for all resource names"
  type        = string
  default     = "lifting-logbook"
}

variable "github_repository" {
  description = <<-EOT
    The "owner/repo" this repository's GitHub Actions runs authenticate as, exactly as
    it appears in the OIDC token's `repository` claim. Single source of truth for the
    Workload Identity Federation trust boundary: it gates the provider's
    attribute_condition AND both service-account principalSet bindings (cicd,
    cicd_plan), which must always agree — a mismatch between them silently yields
    either `unauthorized_client` at token exchange or a failed impersonation.

    Change this in ONE place after any repository transfer or rename. Before #871 the
    same owner/repo string was hard-coded at three separate sites; the transfer to the
    `merickvaughn` org left `main` pinned to the pre-transfer `brownm09` value, and
    because .github/workflows/staging.yml runs `terraform apply` (not plan) on every PR,
    any PR branched from main actively re-applied the stale value to the live provider —
    breaking GCP auth for every other branch, including the PR that carried the fix.
  EOT
  type        = string
  default     = "merickvaughn/lifting-logbook"

  validation {
    # Charset is GitHub's actual owner/repo alphabet, deliberately narrower than a
    # bare "one slash" shape check: the value is interpolated into a single-quoted
    # CEL string in attribute_condition, so admitting a quote here would emit a
    # malformed expression at the only consumer that reads this variable.
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be \"owner/repo\" using only letters, digits, dot, underscore or hyphen in each part."
  }
}

variable "db_tier" {
  description = "Cloud SQL instance tier"
  type        = string
  default     = "db-f1-micro"
}

variable "db_name" {
  description = "Name of the application database within the Cloud SQL instance"
  type        = string
  default     = "lifting_logbook"
}

variable "db_availability_type" {
  description = <<-EOT
    Cloud SQL availability type: "ZONAL" (single zone) or "REGIONAL" (high-availability
    cross-zone standby, ~2x instance cost). Defaults to ZONAL for single-user cost
    savings (#860) — a single-user portfolio app does not need cross-zone failover, and
    point-in-time recovery + daily backups (retained per-environment) still protect the
    data. Set "REGIONAL" per-environment in tfvars to restore HA.
  EOT
  type        = string
  default     = "ZONAL"
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.db_availability_type)
    error_message = "db_availability_type must be 'ZONAL' or 'REGIONAL'."
  }
}

variable "artifact_registry_region" {
  description = "Region for the Artifact Registry repository (shared across environments)"
  type        = string
  default     = "us-central1"
}

variable "gke_release_channel" {
  description = "GKE release channel for auto-upgrades"
  type        = string
  default     = "REGULAR"
}

variable "image_tag" {
  description = "Docker image tag to deploy (git SHA). Defaults to 'latest' for local Terraform runs."
  type        = string
  default     = "latest"
}

variable "enable_gke" {
  description = <<-EOT
    Provision the GKE Autopilot cluster (per ADR-009 A/B comparison).
    Set false for single-user / Cloud-Run-only deployments to skip ~$30/mo of cluster cost.

    Flipping on an existing environment:
      * true → false: `helm uninstall` every release in the cluster namespaces FIRST
        (otherwise cluster-managed cloud resources like LB IPs and PVCs are orphaned
        when terraform destroys the cluster), then apply. See docs/deploy.md.
      * false → true: no cleanup needed; apply, then push to main so CI deploys Helm
        releases onto the freshly created cluster.
  EOT
  type        = bool
  default     = true
}

variable "gke_deletion_protection" {
  description = <<-EOT
    Terraform-side guard on the GKE Autopilot cluster (google_container_cluster.main).
    When true, `terraform apply` refuses to destroy the cluster — including the implicit
    destroy when `enable_gke` flips true → false (count → 0), which then hard-fails with
    "Cannot destroy cluster because deletion_protection is set to true."

    Defaults to false for this single-user / portfolio context so the ADR-009
    GKE-vs-Cloud-Run A/B can be torn down cleanly. Set true (e.g. in
    terraform.tfvars.production) if a future long-lived prod cluster should be protected
    from an accidental terraform destroy. See issue #862.
  EOT
  type        = bool
  default     = false
}

variable "cloud_run_min_instances" {
  description = "Minimum Cloud Run instances per service. null = use environment default (1 in production, 0 in staging). Set 0 in production for scale-to-zero (adds ~2s cold start to first request, near-zero idle cost)."
  type        = number
  default     = null
}

# ─── Edge rate limiting (#808 / ADR-034) ─────────────────────────────────────

variable "enable_edge_load_balancer" {
  description = <<-EOT
    Phase 1 of enabling the edge rate limit (#808 / ADR-034): provision the external
    HTTPS Application Load Balancer + Cloud Armor policy in front of the web Cloud Run
    service. Default false: the app serves directly off *.run.app and the entire stack
    (edge-load-balancer.tf) is count=0, so `terraform plan` is a no-op on the committed
    tfvars.

    Creating the LB REQUIRES var.web_domain (a managed cert cannot cover *.run.app) and
    a DNS cutover to the load balancer IP (output edge_lb_ip). It does NOT by itself lock
    down run.app — that is phase 2 (var.lock_web_ingress_to_lb), flipped only after the
    cert is ACTIVE, so enabling never causes downtime. See ADR-034 and docs/deploy.md for
    the two-phase enable procedure; tracked in #826 (the #804 collector wiring has landed,
    so the surface is live).
  EOT
  type        = bool
  default     = false
}

variable "lock_web_ingress_to_lb" {
  description = <<-EOT
    Phase 2 of enabling the edge rate limit (#808 / ADR-034): set the web Cloud Run
    service ingress to INTERNAL_AND_CLOUD_LOAD_BALANCING so the public *.run.app URL
    cannot bypass the load balancer's rate limit. Requires enable_edge_load_balancer =
    true (enforced by a precondition on the web service). Flip this ONLY after the LB is
    serving and its managed cert is ACTIVE — otherwise run.app is locked while the LB
    cannot yet serve HTTPS and the site goes dark. Default false = no ingress change.
  EOT
  type        = bool
  default     = false
}

variable "web_domain" {
  description = <<-EOT
    Public APEX domain served by the web load balancer (e.g. "liftinglogbook.com").
    Required when enable_edge_load_balancer = true — a Google-managed SSL certificate
    cannot be issued for a *.run.app URL. Additional hostnames (e.g. www) go in
    var.web_domain_aliases; the LB's managed cert covers the apex plus every alias.
    Empty otherwise.
  EOT
  type        = string
  default     = ""
}

variable "web_domain_aliases" {
  description = <<-EOT
    Additional hostnames beyond var.web_domain to include on the web load balancer's
    managed SSL certificate (e.g. ["www.liftinglogbook.com"]). Each alias is validated by
    its own Certificate Manager DNS authorization and must have its serving DNS record
    pointed at the LB IP during the cutover; like the apex, any pre-existing Cloud Run
    domain mapping for an alias must be deleted before phase 2 locks web ingress to the LB
    (an ingress-locked service cannot serve a domain mapping). Empty by default; only used
    when enable_edge_load_balancer = true.
  EOT
  type        = list(string)
  default     = []
}

variable "client_error_rate_limit_count" {
  description = <<-EOT
    Cloud Armor per-IP throttle threshold for POST /api/client-errors: requests
    allowed per 60s per source IP before excess is dropped with 429 (#808). Kept
    generous — a single failing page emits several best-effort beacons — while still
    hard-bounding a scripted single-IP flood's retained-ERROR-span volume. Only used
    when enable_edge_load_balancer = true.
  EOT
  type        = number
  default     = 120
}

variable "google_oauth_client_id" {
  description = <<-EOT
    The Google OAuth client ID for linking a supplement sheet (#1432, ADR-047 decision 9). Not a
    secret. Empty leaves linking off: the API answers 503 google-sheet-unconfigured.
  EOT
  type        = string
  default     = ""
}
