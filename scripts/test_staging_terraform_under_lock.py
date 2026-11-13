#!/usr/bin/env python3
"""Every staging `terraform apply` in CI runs while its run holds the staging lock (#1216).

The staging environment lock (scripts/staging-env-lock.py, #1208) keeps one run from changing
staging under another run's integration tests. A `terraform apply` against staging changes its
Cloud Run services, IAM and networking, so it has to run inside that lock too. Until #1216 it
didn't: both staging.yml and deploy.yml applied in a `terraform-staging` job that ran before the
lock was taken.

This reads .github/workflows/staging.yml and deploy.yml. A staging job is one that runs tf-init
with `workspace: staging` or passes terraform.tfvars.staging. For every step in one that runs
`terraform apply` (in its `run`, or in a local composite action it uses), it checks:

1. An earlier step in the same job runs `staging-env-lock.py acquire`, unconditionally and without
   `continue-on-error`. acquire fails unless this run ends up holding the lock, so the apply can't
   run without it, including on a re-run of failed jobs. No step between them releases the lock,
   and the apply step has no `if:` with a status function that would run it after a failed acquire.
2. That job, or a job it needs (directly or through other jobs), runs an acquire that waits
   (`--timeout-min` above 0), so the first attempt waits for the lock instead of failing at once.

Run locally:  ``python scripts/test_staging_terraform_under_lock.py -v``   (needs PyYAML)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import os
import re
import unittest
from unittest import mock

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = {
    name: os.path.join(ROOT, ".github", "workflows", name) for name in ("staging.yml", "deploy.yml")
}


def load(name):
    with open(WORKFLOWS[name], encoding="utf-8") as f:
        return yaml.safe_load(f)


def step_commands(step):
    """The shell a step runs: its `run`, or for a local composite action, its steps' `run`s.

    Reading a local action's commands (not its whole file, whose comments may mention
    `terraform apply`) means an apply moved into an action is still seen.
    """
    uses = step.get("uses") or ""
    if uses.startswith("./"):
        path = os.path.join(ROOT, uses[2:], "action.yml")
        with open(path, encoding="utf-8") as f:
            action = yaml.safe_load(f)
        script = "\n".join(s.get("run") or "" for s in action.get("runs", {}).get("steps") or [])
    else:
        script = step.get("run") or ""
    # Shell comment lines describe commands; they don't run them.
    return "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("#"))


def is_staging_job(job):
    """A job that initializes or targets the staging Terraform workspace."""
    for step in job.get("steps") or []:
        if "tf-init" in (step.get("uses") or "") and (step.get("with") or {}).get("workspace") == "staging":
            return True
        if "terraform.tfvars.staging" in step_commands(step):
            return True
    return False


def is_apply(step):
    return "terraform apply" in step_commands(step)


def acquire_timeout(step):
    """The --timeout-min of a staging-env-lock.py acquire step, or None if the step isn't one.

    A step with no --timeout-min, or a non-numeric one (an env reference such as
    "$STAGING_LOCK_TIMEOUT_MIN"), waits: the script's default is 45 minutes.
    """
    run = step.get("run") or ""
    if "staging-env-lock.py acquire" not in run:
        return None
    m = re.search(r'--timeout-min[=\s]+"?([0-9.]+)"?', run)
    return float(m.group(1)) if m else float("inf")


def holds_lock(step):
    """An acquire step that always runs and fails the job when it doesn't get the lock."""
    return (
        acquire_timeout(step) is not None
        and "if" not in step
        and not step.get("continue-on-error", False)
    )


def releases_lock(step):
    return "staging-env-lock.py release" in (step.get("run") or "")


# A step `if:` with one of these still runs after an earlier step failed, so after a failed acquire.
STATUS_FUNCTIONS = ("always()", "failure()", "cancelled()")


def needs_of(job):
    needs = job.get("needs") or []
    return [needs] if isinstance(needs, str) else list(needs)


def upstream(jobs, name):
    """The job and every job it needs, directly or through other jobs."""
    seen, todo = set(), [name]
    while todo:
        n = todo.pop()
        if n not in seen:
            seen.add(n)
            todo.extend(needs_of(jobs[n]))
    return seen


def violations(workflow):
    """(job, problem) pairs for staging applies that can run without the lock, and the apply jobs."""
    jobs = workflow["jobs"]
    found, problems = [], []
    for name, job in jobs.items():
        if not is_staging_job(job):
            continue
        steps = job.get("steps") or []
        for i, step in enumerate(steps):
            if not is_apply(step):
                continue
            found.append(name)
            holds = [k for k, s in enumerate(steps[:i]) if holds_lock(s)]
            if not holds:
                problems.append((name, f"step '{step.get('name')}' runs before this job holds the staging lock"))
            elif any(releases_lock(s) for s in steps[holds[0] + 1:i]):
                problems.append((name, f"step '{step.get('name')}' runs after a step that releases the staging lock"))
            if any(fn in str(step.get("if", "")) for fn in STATUS_FUNCTIONS):
                problems.append((name, f"step '{step.get('name')}' has a status-function if: and runs after a failed acquire"))
            waits = any(
                (acquire_timeout(s) or 0) > 0
                for n in upstream(jobs, name)
                for s in (jobs[n].get("steps") or [])
                if n != name or s in steps[:i]
            )
            if not waits:
                problems.append((name, "neither this job nor a job it needs waits for the staging lock"))
    return found, problems


real_step_commands = step_commands
SHARED_APPLY = "./.github/actions/tf-apply-staging"


class StagingApplyUnderLockTests(unittest.TestCase):
    def test_staging_yml_applies_only_under_the_lock(self):
        found, problems = violations(load("staging.yml"))
        self.assertEqual(found, ["terraform-staging"], "expected exactly one staging apply job")
        self.assertEqual(problems, [])

    def test_deploy_yml_applies_only_under_the_lock(self):
        found, problems = violations(load("deploy.yml"))
        self.assertEqual(found, ["deploy-staging"], "expected exactly one staging apply job")
        self.assertEqual(problems, [])

    def test_staging_yml_apply_job_comes_after_lock_staging(self):
        jobs = load("staging.yml")["jobs"]
        self.assertIn("lock-staging", upstream(jobs, "terraform-staging"))
        # The deploys and tests use this run's Terraform outputs, so they wait for the apply.
        for job in ("deploy-api", "deploy-web", "staging-integration-tests", "unlock-staging"):
            self.assertIn("terraform-staging", needs_of(jobs[job]), job)

    # Rule 4: the check goes red when the lock is taken away from the apply.

    def test_apply_before_the_lock_is_a_violation(self):
        """The pre-#1216 shape: terraform-staging needs only preflight and never acquires."""
        wf = load("staging.yml")
        job = wf["jobs"]["terraform-staging"]
        job["needs"] = ["preflight"]
        job["steps"] = [s for s in job["steps"] if acquire_timeout(s) is None]
        _, problems = violations(wf)
        self.assertEqual(len(problems), 2, problems)

    def test_apply_moved_above_the_acquire_is_a_violation(self):
        wf = load("deploy.yml")
        steps = wf["jobs"]["deploy-staging"]["steps"]
        apply = next(s for s in steps if is_apply(s))
        steps.remove(apply)
        steps.insert(0, apply)
        _, problems = violations(wf)
        self.assertTrue(any("before this job holds" in p for _, p in problems), problems)

    def test_skippable_or_soft_acquire_does_not_count(self):
        for mutate in (lambda s: s.__setitem__("if", "always()"),
                       lambda s: s.__setitem__("continue-on-error", True)):
            wf = load("staging.yml")
            hold = next(s for s in wf["jobs"]["terraform-staging"]["steps"] if acquire_timeout(s) is not None)
            mutate(hold)
            _, problems = violations(wf)
            self.assertTrue(any("before this job holds" in p for _, p in problems), problems)

    def test_no_waiting_acquire_upstream_is_a_violation(self):
        wf = load("staging.yml")
        wf["jobs"]["terraform-staging"]["needs"] = ["preflight"]
        _, problems = violations(wf)
        self.assertEqual(problems, [("terraform-staging", "neither this job nor a job it needs waits for the staging lock")])

    def test_apply_that_runs_after_a_failed_acquire_is_a_violation(self):
        for cond in ("always()", "failure()", "!cancelled()"):
            wf = load("deploy.yml")
            apply = next(s for s in wf["jobs"]["deploy-staging"]["steps"] if is_apply(s))
            apply["if"] = cond
            _, problems = violations(wf)
            self.assertTrue(any("status-function" in p for _, p in problems), (cond, problems))

    def test_release_between_acquire_and_apply_is_a_violation(self):
        wf = load("staging.yml")
        steps = wf["jobs"]["terraform-staging"]["steps"]
        i = next(k for k, s in enumerate(steps) if is_apply(s))
        steps.insert(i, {"name": "Release", "run": 'python3 scripts/staging-env-lock.py release --bucket "b"'})
        _, problems = violations(wf)
        self.assertTrue(any("releases the staging lock" in p for _, p in problems), problems)

    def test_plan_then_apply_before_the_lock_is_seen(self):
        """`plan -out` with the staging tfvars, then `apply <planfile>` without them, in build-images."""
        wf = load("staging.yml")
        wf["jobs"]["build-images"]["steps"][1:1] = [
            {"name": "Plan", "run": "terraform plan -var-file=terraform.tfvars.staging -out=p"},
            {"name": "Apply plan", "run": "terraform apply p"},
        ]
        found, problems = violations(wf)
        self.assertIn("build-images", found)
        self.assertIn(("build-images", "step 'Apply plan' runs before this job holds the staging lock"), problems)

    def test_apply_inside_a_local_action_is_seen(self):
        with mock.patch(f"{__name__}.step_commands", side_effect=lambda s: (
                "terraform apply -auto-approve" if s.get("uses") == "./.github/actions/tf-apply"
                else real_step_commands(s))):
            wf = load("staging.yml")
            wf["jobs"]["preflight"]["steps"].append(
                {"uses": "./.github/actions/tf-init", "with": {"workspace": "staging"}})
            wf["jobs"]["preflight"]["steps"].append({"name": "Apply", "uses": "./.github/actions/tf-apply"})
            found, problems = violations(wf)
        self.assertIn("preflight", found)
        self.assertTrue(any(job == "preflight" for job, _ in problems), problems)

    def test_both_workflows_apply_staging_through_the_shared_action(self):
        """#1266: one copy of the staging apply, so a fix can't reach one workflow and miss the other."""
        for name, job in (("staging.yml", "terraform-staging"), ("deploy.yml", "deploy-staging")):
            applies = [s for s in load(name)["jobs"][job]["steps"] if is_apply(s)]
            self.assertEqual([s.get("uses") for s in applies], [SHARED_APPLY], name)
            self.assertEqual(applies[0].get("id"), "tf-outputs", f"{name}: the job reads steps.tf-outputs")
        # The action captures the outputs and runs the Artifact Registry check, not the callers.
        self.assertIn("artifact_registry_repo", real_step_commands({"uses": SHARED_APPLY}))

    def test_every_terraform_apply_in_staging_yml_is_checked(self):
        """staging.yml only targets staging, so every apply in it must be one this test checks."""
        jobs = load("staging.yml")["jobs"]
        applies = [n for n, j in jobs.items() for s in j.get("steps") or [] if is_apply(s)]
        self.assertEqual(applies, ["terraform-staging"])

    def test_timeout_parsing(self):
        step = lambda run: {"run": run}
        self.assertEqual(acquire_timeout(step('staging-env-lock.py acquire --bucket b --timeout-min=0')), 0)
        self.assertEqual(acquire_timeout(step('staging-env-lock.py acquire --bucket b --timeout-min 0')), 0)
        self.assertEqual(acquire_timeout(step('staging-env-lock.py acquire --bucket b --timeout-min 80 --holder-job "x"')), 80)
        self.assertEqual(acquire_timeout(step('staging-env-lock.py acquire --timeout-min "$STAGING_LOCK_TIMEOUT_MIN"')), float("inf"))
        self.assertIsNone(acquire_timeout(step('staging-env-lock.py release --bucket b')))


if __name__ == "__main__":
    unittest.main()
