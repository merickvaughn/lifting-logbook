#!/usr/bin/env python3
"""Web and api report the same `environment` from GET /version for each deployment (#1448).

apps/web and apps/api both read DEPLOYMENT_ENVIRONMENT (apps/web/lib/deployment-environment.ts,
apps/api/src/otel.ts). The deploy sets it through the deploy-cloud-run-otel-sidecar action's
`ingress_env`, and deploy.yml's smoke steps fail unless /version reports it
(CHECK_SERVED_VERSION_ENVIRONMENT in scripts/check-served-version.sh). This reads the workflows
and checks:

1. Every Cloud Run deploy through the action, in deploy.yml and staging.yml, sets
   DEPLOYMENT_ENVIRONMENT to the environment its service name says (`-stg-` or `-prod-`).
2. In deploy.yml, every check-served-version.sh step in deploy-staging and deploy-production
   sets CHECK_SERVED_VERSION_ENVIRONMENT to that job's environment, and the web and api probes
   both do, so the two services must agree.

Run locally:  ``python scripts/test_deployment_environment_wiring.py -v``   (needs PyYAML)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import unittest

from test_staging_terraform_under_lock import load

ACTION = "./.github/actions/deploy-cloud-run-otel-sidecar"
SERVED_VERSION = "scripts/check-served-version.sh"
JOB_ENVIRONMENTS = {"deploy-staging": "staging", "deploy-production": "production"}


def expected_for_service(service):
    if "-stg-" in service:
        return "staging"
    if "-prod-" in service:
        return "production"
    return None


def ingress_env(step):
    pairs = {}
    for line in str((step.get("with") or {}).get("ingress_env") or "").splitlines():
        if "=" in line:
            key, value = line.strip().split("=", 1)
            pairs[key] = value
    return pairs


def deploy_problems(workflow):
    """(services deployed, problems) for action deploys without the right DEPLOYMENT_ENVIRONMENT."""
    found, problems = [], []
    for name, job in workflow["jobs"].items():
        for step in job.get("steps") or []:
            if step.get("uses") != ACTION:
                continue
            service = step["with"]["service"]
            found.append(service)
            want = expected_for_service(service)
            got = ingress_env(step).get("DEPLOYMENT_ENVIRONMENT")
            if want is None or got != want:
                problems.append((name, service, got, want))
    return found, problems


def smoke_problems(workflow):
    """(probes per job, problems) for /version probes that don't assert the job's environment."""
    probes, problems = {}, []
    for name, want in JOB_ENVIRONMENTS.items():
        for step in workflow["jobs"][name].get("steps") or []:
            run = step.get("run") or ""
            if SERVED_VERSION not in run:
                continue
            probes.setdefault(name, []).append(run)
            got = (step.get("env") or {}).get("CHECK_SERVED_VERSION_ENVIRONMENT")
            if got != want:
                problems.append((name, step.get("name"), got, want))
    return probes, problems


def probed_services(runs):
    return {kind for run in runs for kind in ("web", "api") if f"cloud_run_{kind}_url" in run}


class DeploymentEnvironmentWiringTests(unittest.TestCase):
    def test_every_cloud_run_deploy_sets_its_environment(self):
        for wf_name, expected in (
            ("deploy.yml", {"lifting-logbook-stg-api", "lifting-logbook-stg-web",
                            "lifting-logbook-prod-api", "lifting-logbook-prod-web"}),
            ("staging.yml", {"lifting-logbook-stg-api", "lifting-logbook-stg-web"}),
        ):
            with self.subTest(workflow=wf_name):
                found, problems = deploy_problems(load(wf_name))
                self.assertEqual(set(found), expected)
                self.assertEqual(problems, [])

    def test_smoke_asserts_the_environment_on_web_and_api(self):
        probes, problems = smoke_problems(load("deploy.yml"))
        self.assertEqual(set(probes), set(JOB_ENVIRONMENTS))
        for name, runs in probes.items():
            self.assertEqual(probed_services(runs), {"web", "api"}, name)
        self.assertEqual(problems, [])

    # Each check goes red when the wiring it guards is dropped or wrong.

    def test_missing_deployment_environment_is_a_problem(self):
        wf = load("deploy.yml")
        step = next(s for s in wf["jobs"]["deploy-production"]["steps"]
                    if s.get("uses") == ACTION and s["with"]["service"] == "lifting-logbook-prod-web")
        del step["with"]["ingress_env"]
        _, problems = deploy_problems(wf)
        self.assertIn(("deploy-production", "lifting-logbook-prod-web", None, "production"), problems)

    def test_wrong_deployment_environment_is_a_problem(self):
        wf = load("staging.yml")
        step = next(s for job in wf["jobs"].values() for s in job.get("steps") or []
                    if s.get("uses") == ACTION and s["with"]["service"] == "lifting-logbook-stg-api")
        step["with"]["ingress_env"] = step["with"]["ingress_env"].replace(
            "DEPLOYMENT_ENVIRONMENT=staging", "DEPLOYMENT_ENVIRONMENT=production")
        _, problems = deploy_problems(wf)
        self.assertEqual([p[1:] for p in problems], [("lifting-logbook-stg-api", "production", "staging")])

    def test_smoke_without_the_environment_is_a_problem(self):
        wf = load("deploy.yml")
        step = next(s for s in wf["jobs"]["deploy-staging"]["steps"] if SERVED_VERSION in (s.get("run") or ""))
        step.pop("env")
        _, problems = smoke_problems(wf)
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0][2:], (None, "staging"))


if __name__ == "__main__":
    unittest.main()
