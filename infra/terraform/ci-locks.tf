# ─── Staging environment lock bucket (#1217) ─────────────────────────────────
# scripts/staging-env-lock.py holds staging from a run's deploy through its integration tests
# (#1208). It writes, refreshes and deletes small objects many times a day, so it gets its own
# bucket. It used to write them in the Terraform state bucket, which keeps object versions for state
# recovery, so every lock write left a noncurrent version that never expired (#1217).
#
# Staging only: production has no lock. The name is `<project id>-ci-locks`; staging.yml and
# deploy.yml derive it the same way from vars.GCP_STAGING_PROJECT_ID (STAGING_LOCK_BUCKET).
#
# Every PR's staging run applies Terraform from its own branch, so an apply from a config older
# than this file destroys this bucket whenever no lock is in it (#1260). The workflows take the lock
# before they apply, so no apply would put it back: instead staging-env-lock.py recreates a missing
# bucket with these settings (--recreate-in-project), and the import block below adopts it (#1261).
# Bootstrapping a new staging project: create the bucket before its first apply, since the import
# block fails on a bucket that doesn't exist.
import {
  for_each = var.environment == "staging" ? toset(["${var.project_id}-ci-locks"]) : toset([])
  to       = google_storage_bucket.ci_locks[0]
  id       = each.value
}

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

  # Don't delete a held lock. An apply from a config without this file (a re-run of an old run,
  # whose merge commit predates it) plans to destroy this bucket. With objects in it, that apply
  # fails and the lock survives. A deliberate teardown deletes any leftover lock object first.
  force_destroy = false
}

# The staging CI/CD SA is project owner, but grant the object role explicitly so the lock doesn't
# depend on basic-role inheritance.
resource "google_storage_bucket_iam_member" "ci_locks_cicd" {
  count = var.environment == "staging" ? 1 : 0

  bucket = google_storage_bucket.ci_locks[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.cicd.email}"
}
