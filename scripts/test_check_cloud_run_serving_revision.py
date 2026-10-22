#!/usr/bin/env python3
"""Tests for scripts/check-cloud-run-serving-revision.py (#1042).

The check is a deploy gate: every Cloud Run deploy (the deploy-cloud-run-otel-sidecar composite
action) fails if it does not pass. A gate must be calibrated both ways: it has to pass the healthy
shape a real deploy produces and fail every shape of "the URL is not answering from the new
revision". The known-good fixture is a scrubbed `gcloud run services describe --format=json` of
the live staging API (2026-10-22). Each known-bad case starts from it and changes one field. The
first one is the real incident: 100% pinned to `...-00527-krj` while newer revisions sat at 0%.

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

IMAGE = GOOD["spec"]["template"]["spec"]["containers"][0]["image"]
NEWEST = GOOD["status"]["latestReadyRevisionName"]
PINNED = "lifting-logbook-stg-api-00527-krj"


def run_check(svc, *args):
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        input=json.dumps(svc), capture_output=True, text=True,
    )


def with_status(**changes):
    svc = copy.deepcopy(GOOD)
    svc["status"].update(changes)
    return svc


class KnownGoodTest(unittest.TestCase):
    """The healthy shape a real deploy produces must pass."""

    def test_live_staging_shape_passes(self):
        proc = run_check(GOOD)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn(NEWEST, proc.stdout)
        self.assertNotIn("::error", proc.stdout)

    def test_live_staging_shape_passes_with_matching_image(self):
        proc = run_check(GOOD, "--image", IMAGE)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_explicit_revision_name_at_100_passes(self):
        # Traffic routed to the newest revision by name (no latestRevision flag) is still correct.
        svc = with_status(traffic=[{"percent": 100, "revisionName": NEWEST}])
        proc = run_check(svc)
        self.assertEqual(proc.returncode, 0, proc.stdout)

    def test_latest_flag_without_revision_name_passes(self):
        svc = with_status(traffic=[{"latestRevision": True, "percent": 100}])
        proc = run_check(svc)
        self.assertEqual(proc.returncode, 0, proc.stdout)


class KnownBadTest(unittest.TestCase):
    """Each shape in which the URL is not answering from the new revision must fail, with its own message."""

    def assert_fails(self, svc, needle, *args):
        proc = run_check(svc, *args)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("::error", proc.stdout)
        self.assertIn(needle, proc.stdout)

    def test_incident_shape_pinned_to_old_revision_fails(self):
        # #1042: spec and status both pinned to a July revision; newer revisions created at 0%.
        svc = with_status(traffic=[{"percent": 100, "revisionName": PINNED}])
        svc["spec"]["traffic"] = [{"percent": 100, "revisionName": PINNED}]
        self.assert_fails(svc, f"0% of traffic goes to the newest revision {NEWEST}")
        self.assert_fails(svc, f"{PINNED}=100%")

    def test_split_traffic_fails(self):
        svc = with_status(traffic=[
            {"percent": 90, "revisionName": PINNED},
            {"latestRevision": True, "percent": 10, "revisionName": NEWEST},
        ])
        self.assert_fails(svc, "10% of traffic goes to the newest revision")

    def test_newest_revision_not_ready_fails(self):
        svc = with_status(latestCreatedRevisionName="lifting-logbook-stg-api-00784-new")
        self.assert_fails(svc, "lifting-logbook-stg-api-00784-new is not ready")

    def test_stale_status_generation_fails(self):
        svc = with_status(observedGeneration=784)
        self.assert_fails(svc, "observedGeneration (784) does not match metadata.generation (785)")

    def test_empty_traffic_fails_rather_than_passing_vacuously(self):
        self.assert_fails(with_status(traffic=[]), "status.traffic is missing or empty")

    def test_missing_traffic_fails_rather_than_passing_vacuously(self):
        svc = copy.deepcopy(GOOD)
        del svc["status"]["traffic"]
        self.assert_fails(svc, "status.traffic is missing or empty")

    def test_missing_status_fails(self):
        svc = copy.deepcopy(GOOD)
        del svc["status"]
        self.assert_fails(svc, "status.traffic is missing or empty")

    def test_image_mismatch_fails(self):
        other = IMAGE.rsplit(":", 1)[0] + ":0000000000000000000000000000000000000000"
        self.assert_fails(GOOD, f"no container runs {other}", "--image", other)

    def test_unparseable_input_fails(self):
        proc = subprocess.run([sys.executable, SCRIPT], input="not json", capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("could not parse describe JSON", proc.stdout)


if __name__ == "__main__":
    unittest.main()
