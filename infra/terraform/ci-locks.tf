# ─── Staging environment lock bucket (#1217) ─────────────────────────────────
# scripts/staging-env-lock.py holds staging from a run's deploy through its integration tests
# (#1208). It writes, refreshes and deletes small objects many times a day, so it gets its own
# bucket. It writes them in the Terraform state bucket until #1261. That bucket keeps object
# versions for state recovery, so every lock write leaves a noncurrent version that never expires,
# mixed in with production Terraform state.
#
# Staging only: production has no lock. The name is `<project id>-ci-locks`, so workflows can
# derive it from vars.GCP_STAGING_PROJECT_ID.
#
# This lands on main before any workflow uses it (#1260, then #1261). Every PR's staging run
# applies Terraform from its own branch, so a resource that exists on only one branch is destroyed
# by the next branch's apply, and a lock in it would vanish mid-run.
resource "google_storage_bucket" "ci_locks" {
  count = var.environment == "staging" ? 1 : 0

  name     = "${var.project_id}-ci-locks"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # The lock is only meaningful while its holder runs; there is nothing to recover.
  # No versioning, so a write or delete leaves no noncurrent version, and no soft delete,
  # so a deleted lock isn't kept for the default 7 days either.
  versioning {
    enabled = false
  }
  soft_delete_policy {
    retention_duration_seconds = 0
  }

  # Lock objects are scratch. A teardown shouldn't fail on a lock a run left behind.
  force_destroy = true
}

# The staging CI/CD SA is project owner, but grant the object role explicitly so the lock doesn't
# depend on basic-role inheritance.
resource "google_storage_bucket_iam_member" "ci_locks_cicd" {
  count = var.environment == "staging" ? 1 : 0

  bucket = google_storage_bucket.ci_locks[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.cicd.email}"
}
