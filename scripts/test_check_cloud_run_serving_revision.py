#!/usr/bin/env python3
"""Tests for scripts/check-cloud-run-serving-revision.py (#1042).

The check is a deploy gate: every Cloud Run deploy (the deploy-cloud-run-otel-sidecar composite
action) fails if it does not pass. A gate must be calibrated both ways: it has to pass every shape
a healthy deploy can leave behind and fail every shape of "traffic is pinned away from the newest
revision". The known-good fixture is a scrubbed `gcloud run services describe --format=json` of the
live staging API (2026-10-22). Each other case starts from it and changes one thing. The first
known-bad case is the real incident: 100% pinned to `...-00527-krj` while newer revisions sat at 0%.

Known-good includes the concurrent-deploy shapes. staging.yml and deploy.yml both deploy to the
staging services without a shared lock, so the gate can read the service while another deploy is
mid-rollout or has already replaced it. Those must pass; only a pin may fail.

Design mirrors scripts/test_inject_otel_sidecar.py: stdlib ``unittest``, with the script run as a
*subprocess* so the CLI contract the action relies on is exercised end to end: stdin JSON,
`::error::` lines on stdout, and the exit code.

Run locally:  ``python scripts/test_check_cloud_run_serving_revision.py -v``   (no dependencies)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import copy
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "check-cloud-run-serving-revision.py")
FIXTURE = os.path.join(HERE, "testdata", "cloud-run-api-describe.json")

with open(FIXTURE, encoding="utf-8") as f:
    GOOD = json.load(f)

NEWEST = GOOD["status"]["latestReadyRevisionName"]
PINNED = "lifting-logbook-stg-api-00527-krj"
ROLLING_OUT = "lifting-logbook-stg-api-00784-new"


def run_check(svc):
    return subprocess.run(
        [sys.executable, SCRIPT], input=json.dumps(svc), capture_output=True, text=True,
    )


def with_status(**changes):
    svc = copy.deepcopy(GOOD)
    svc["status"].update(changes)
    return svc


class KnownGoodTest(unittest.TestCase):
    """Every shape a healthy deploy can leave behind must pass."""

    def assert_passes(self, svc):
        proc = run_check(svc)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("::error", proc.stdout)
        return proc

    def test_live_staging_shape_passes(self):
        self.assertIn(NEWEST, self.assert_passes(GOOD).stdout)

    def test_explicit_revision_name_at_100_passes(self):
        # Traffic routed to the newest revision by name (no latestRevision flag) is still correct.
        self.assert_passes(with_status(traffic=[{"percent": 100, "revisionName": NEWEST}]))

    def test_latest_flag_without_revision_name_passes(self):
        self.assert_passes(with_status(traffic=[{"latestRevision": True, "percent": 100}]))

    def test_concurrent_deploy_still_rolling_out_passes(self):
        # Another workflow's replace is in flight: generation moved on, its revision isn't ready
        # yet, and traffic correctly stays on the newest READY revision. Not a pin.
        svc = with_status(observedGeneration=785, latestCreatedRevisionName=ROLLING_OUT)
        svc["metadata"]["generation"] = 786
        self.assert_passes(svc)

    def test_concurrent_deploy_already_landed_passes(self):
        # Another workflow replaced the service after this one: a different image and a newer
        # ready revision, which takes 100% of traffic. Not a pin.
        svc = with_status(
            latestCreatedRevisionName=ROLLING_OUT, latestReadyRevisionName=ROLLING_OUT,
            traffic=[{"latestRevision": True, "percent": 100, "revisionName": ROLLING_OUT}],
        )
        svc["spec"]["template"]["spec"]["containers"][0]["image"] = "registry/api:pr-1052"
        self.assert_passes(svc)


class KnownBadTest(unittest.TestCase):
    """Every shape in which traffic is pinned away from the newest revision must fail, with its own message."""

    def assert_fails(self, svc, needle):
        proc = run_check(svc)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("::error", proc.stdout)
        self.assertIn(needle, proc.stdout)

    def test_incident_shape_pinned_to_old_revision_fails(self):
        # #1042: spec and status both pinned to a July revision; newer revisions created at 0%.
        svc = with_status(traffic=[{"percent": 100, "revisionName": PINNED}])
        svc["spec"]["traffic"] = [{"percent": 100, "revisionName": PINNED}]
        self.assert_fails(svc, f"0% of traffic goes to the newest ready revision {NEWEST}")
        self.assert_fails(svc, f"{PINNED}=100%")

    def test_split_traffic_fails(self):
        svc = with_status(traffic=[
            {"percent": 90, "revisionName": PINNED},
            {"latestRevision": True, "percent": 10, "revisionName": NEWEST},
        ])
        self.assert_fails(svc, "10% of traffic goes to the newest ready revision")

    def test_empty_traffic_fails_rather_than_passing_vacuously(self):
        self.assert_fails(with_status(traffic=[]), "status.traffic is missing or empty")

    def test_missing_traffic_fails_rather_than_passing_vacuously(self):
        svc = copy.deepcopy(GOOD)
        del svc["status"]["traffic"]
        self.assert_fails(svc, "status.traffic is missing or empty")

    def test_missing_latest_ready_revision_fails(self):
        svc = copy.deepcopy(GOOD)
        del svc["status"]["latestReadyRevisionName"]
        self.assert_fails(svc, "latestReadyRevisionName is missing")

    def test_missing_status_fails(self):
        svc = copy.deepcopy(GOOD)
        del svc["status"]
        self.assert_fails(svc, "latestReadyRevisionName is missing")

    def test_unparseable_input_fails(self):
        proc = subprocess.run([sys.executable, SCRIPT], input="not json", capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("could not parse describe JSON", proc.stdout)


if __name__ == "__main__":
    unittest.main()
