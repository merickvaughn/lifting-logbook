#!/usr/bin/env python3
"""deploy.yml's staging smoke test probes this merge's build, under the staging lock (#1052).

The staging smoke test is the gate deploy-production needs. staging.yml deploys the same staging
Cloud Run services for every PR push and merge-queue entry, so a probe that runs after deploy.yml
releases the staging lock (scripts/staging-env-lock.py, #1208) can hit another run's build: until
#1052 the smoke test was its own job, after deploy-staging had released the lock.

This reads .github/workflows/deploy.yml and checks:

1. Every step that probes a staging URL (a `curl` or `check-served-version.sh` against
   `steps.tf-outputs.outputs.cloud_run_*` in a staging job, or `needs.deploy-staging.outputs.*`)
   runs after a step in its job that holds the lock, with no release in between and no
   status-function `if:` that would run it after a failed acquire.
2. The staging smoke asserts `GET /version` == `github.sha` on both the web and the api URL, so it
   proves which build answered, not just that something did.
3. deploy-production runs only when that job succeeded.

Run locally:  ``python scripts/test_staging_smoke_under_lock.py -v``   (needs PyYAML)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import unittest

from test_staging_terraform_under_lock import (
    STATUS_FUNCTIONS,
    holds_lock,
    is_staging_job,
    load,
    releases_lock,
)

STAGING_URLS = ("steps.tf-outputs.outputs.cloud_run_", "needs.deploy-staging.outputs.cloud_run_")
SERVED_VERSION = "scripts/check-served-version.sh"


def probes_staging(job, step):
    run = step.get("run") or ""
    if "curl" not in run and SERVED_VERSION not in run:
        return False
    if "needs.deploy-staging.outputs.cloud_run_" in run:
        return True
    return is_staging_job(job) and STAGING_URLS[0] in run


def violations(workflow):
    """(probe jobs, problems) for staging probes that can run outside the staging lock."""
    found, problems = [], []
    for name, job in workflow["jobs"].items():
        steps = job.get("steps") or []
        for i, step in enumerate(steps):
            if not probes_staging(job, step):
                continue
            found.append(name)
            label = f"step '{step.get('name')}'"
            holds = [k for k, s in enumerate(steps[:i]) if holds_lock(s)]
            if not holds:
                problems.append((name, f"{label} probes staging without holding the staging lock"))
            elif any(releases_lock(s) for s in steps[holds[0] + 1:i]):
                problems.append((name, f"{label} probes staging after the staging lock is released"))
            if any(fn in str(step.get("if", "")) for fn in STATUS_FUNCTIONS):
                problems.append((name, f"{label} has a status-function if: and runs after a failed acquire"))
    return found, problems


def served_version_targets(job):
    """The staging URL output each check-served-version.sh call in the job is pointed at."""
    targets = set()
    for step in job.get("steps") or []:
        run = step.get("run") or ""
        if SERVED_VERSION not in run or "${{ github.sha }}" not in run:
            continue
        for out in ("cloud_run_web_url", "cloud_run_api_url"):
            if STAGING_URLS[0] + out[len("cloud_run_"):] in run:
                targets.add(out)
    return targets


class StagingSmokeUnderLockTests(unittest.TestCase):
    def test_every_staging_probe_runs_under_the_lock(self):
        found, problems = violations(load("deploy.yml"))
        self.assertEqual(set(found), {"deploy-staging"}, "expected the staging probes in deploy-staging only")
        self.assertGreaterEqual(len(found), 4, "expected the /livez, /sign-in, web /version and api probes")
        self.assertEqual(problems, [])

    def test_smoke_asserts_the_served_build_on_web_and_api(self):
        job = load("deploy.yml")["jobs"]["deploy-staging"]
        self.assertEqual(served_version_targets(job), {"cloud_run_web_url", "cloud_run_api_url"})

    def test_production_waits_for_the_staging_job(self):
        prod = load("deploy.yml")["jobs"]["deploy-production"]
        self.assertIn("deploy-staging", prod["needs"])
        self.assertIn("needs.deploy-staging.result == 'success'", prod["if"])

    # Rule 4: each check goes red when the smoke test leaves the lock or stops checking the build.

    def test_smoke_in_a_later_job_is_a_violation(self):
        """The pre-#1052 shape: a smoke-test job that probes deploy-staging's outputs."""
        wf = load("deploy.yml")
        wf["jobs"]["smoke-test"] = {
            "needs": ["deploy-staging"],
            "steps": [{"name": "Smoke", "run": 'curl "${{ needs.deploy-staging.outputs.cloud_run_web_url }}/livez"'}],
        }
        _, problems = violations(wf)
        self.assertIn(("smoke-test", "step 'Smoke' probes staging without holding the staging lock"), problems)

    def test_release_before_the_smoke_is_a_violation(self):
        wf = load("deploy.yml")
        steps = wf["jobs"]["deploy-staging"]["steps"]
        release = next(s for s in steps if releases_lock(s))
        release.pop("if", None)
        steps.remove(release)
        first_probe = next(k for k, s in enumerate(steps) if probes_staging(wf["jobs"]["deploy-staging"], s))
        steps.insert(first_probe, release)
        _, problems = violations(wf)
        self.assertTrue(any("after the staging lock is released" in p for _, p in problems), problems)

    def test_probe_after_a_failed_acquire_is_a_violation(self):
        wf = load("deploy.yml")
        job = wf["jobs"]["deploy-staging"]
        probe = next(s for s in job["steps"] if probes_staging(job, s))
        probe["if"] = "always()"
        _, problems = violations(wf)
        self.assertTrue(any("status-function" in p for _, p in problems), problems)

    def test_dropping_a_served_version_check_is_seen(self):
        job = load("deploy.yml")["jobs"]["deploy-staging"]
        job["steps"] = [s for s in job["steps"]
                        if not (SERVED_VERSION in (s.get("run") or "") and "cloud_run_web_url" in (s.get("run") or ""))]
        self.assertEqual(served_version_targets(job), {"cloud_run_api_url"})


if __name__ == "__main__":
    unittest.main()
