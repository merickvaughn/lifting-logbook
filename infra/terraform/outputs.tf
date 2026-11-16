output "gke_enabled" {
  description = "Whether GKE is provisioned for this environment"
  value       = var.enable_gke
}

output "gke_cluster_name" {
  description = "GKE cluster name (used by helm deploy step in CI/CD). Empty when enable_gke = false."
  value       = var.enable_gke ? google_container_cluster.main[0].name : ""
}

output "gke_cluster_location" {
  description = "GKE cluster region. Empty when enable_gke = false."
  value       = var.enable_gke ? google_container_cluster.main[0].location : ""
}

output "cloud_run_api_url" {
  description = "Cloud Run API service URL"
  value       = google_cloud_run_v2_service.api.uri
}

output "cloud_run_web_url" {
  description = "Cloud Run web service URL"
  value       = google_cloud_run_v2_service.web.uri
}

output "artifact_registry_host" {
  description = "Artifact Registry hostname for Docker push/pull"
  value       = "${var.artifact_registry_region}-docker.pkg.dev"
}

output "artifact_registry_repo" {
  description = "Full Artifact Registry repository path"
  value       = "${var.artifact_registry_region}-docker.pkg.dev/${var.project_id}/${var.app_name}"
}

output "otel_collector_mirror_repo" {
  description = "Docker Hub pull-through mirror base path (#795); append /otel/opentelemetry-collector-contrib@<digest>"
  value       = "${var.artifact_registry_region}-docker.pkg.dev/${var.project_id}/${var.app_name}-dockerhub"
}

output "cicd_service_account_email" {
  description = "CI/CD service account email (referenced in GitHub Actions secrets)"
  value       = google_service_account.cicd.email
}

output "cicd_plan_service_account_email" {
  description = "Read-only plan service account email (#545) — set as the GCP_PROD_PLAN_SERVICE_ACCOUNT secret so the plan-production CI job authenticates with least privilege."
  value       = google_service_account.cicd_plan.email
}

output "workload_identity_provider" {
  description = "Workload Identity Federation provider resource name (used in GitHub Actions)"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "database_instance_name" {
  description = "Cloud SQL instance name"
  value       = google_sql_database_instance.main.name
}

output "migrate_job_name" {
  description = "Cloud Run Job that runs prisma migrate deploy against this environment's DB (ADR-027). Executed by the deploy pipeline before the API revision goes live."
  value       = google_cloud_run_v2_job.migrate.name
}

output "expire_snapshots_job_name" {
  description = "Cloud Run Job that deletes expired data snapshots (#1309, ADR-044). Executed daily by .github/workflows/expire-snapshots.yml."
  value       = google_cloud_run_v2_job.expire_snapshots.name
}

output "kms_key_name" {
  description = "Cloud KMS crypto key name for credential encryption (ADR-014)"
  value       = google_kms_crypto_key.user_data_source.id
}

output "edge_lb_ip" {
  description = "External IP of the web load balancer (#808 / ADR-034). Empty unless enable_edge_load_balancer = true; when set, create the DNS A record for web_domain (and each web_domain_aliases entry) pointing at this IP as part of the enable procedure."
  value       = try(google_compute_global_address.web_lb[0].address, "")
}

output "edge_lb_dns_authorizations" {
  description = "Certificate Manager DNS-authorization CNAME records (#808 / ADR-034), keyed by domain. Empty unless enable_edge_load_balancer = true. During the enable cutover, create each CNAME (record_name -> record_data) at the registrar so the managed cert validates while the apex/www still serve via their existing Cloud Run domain mappings (zero-downtime)."
  value = {
    for d, auth in google_certificate_manager_dns_authorization.web :
    d => {
      record_name = auth.dns_resource_record[0].name
      record_type = auth.dns_resource_record[0].type
      record_data = auth.dns_resource_record[0].data
    }
  }
}

output "web_workload_sa" {
  description = "Web Cloud Run workload identity service account email"
  value       = google_service_account.web_workload.email
}
