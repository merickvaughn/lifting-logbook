# ─── Supplement sheet mirror (ADR-047 decisions 15-18, #1443) ────────────────
# Cloud Tasks calls POST /internal/supplement-sheet-mirror on the API with an OIDC token for
# sheet-mirror-tasks. The API checks that token itself (the service is publicly invokable,
# ADR-032), so this account holds no role of its own.

resource "google_cloud_tasks_queue" "supplement_sheet_mirror" {
  name     = "supplement-sheet-mirror"
  location = var.region

  # Keeps the project under the Sheets API's 300 writes a minute at three writes per run.
  rate_limits {
    max_dispatches_per_second = 1
    max_concurrent_dispatches = 5
  }

  # Truncated exponential backoff, with the maximum raised to 10 minutes because nobody waits
  # on a mirror.
  retry_config {
    max_attempts       = 8
    min_backoff        = "10s"
    max_backoff        = "600s"
    max_doublings      = 5
    max_retry_duration = "86400s"
  }

  depends_on = [google_project_service.required_apis]
}

resource "google_service_account" "sheet_mirror_tasks" {
  account_id   = "sheet-mirror-tasks"
  display_name = "${var.app_name} sheet mirror task caller (${var.environment})"
}

# The API enqueues tasks, on this queue only.
resource "google_cloud_tasks_queue_iam_member" "api_workload_enqueuer" {
  name     = google_cloud_tasks_queue.supplement_sheet_mirror.name
  location = google_cloud_tasks_queue.supplement_sheet_mirror.location
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${google_service_account.api_workload.email}"
}

# Attaching sheet-mirror-tasks' OIDC token to a task needs iam.serviceAccounts.actAs on it.
resource "google_service_account_iam_member" "api_workload_acts_as_sheet_mirror_tasks" {
  service_account_id = google_service_account.sheet_mirror_tasks.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api_workload.email}"
}

# No grant for the Cloud Tasks service agent: its default role, roles/cloudtasks.serviceAgent,
# is what mints the token (ADR-047, "Operational steps for the owner", step 7). The Cloud Tasks
# authentication page was not reachable when this was written (#1443), so confirm it there.
