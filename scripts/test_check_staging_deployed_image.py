#!/usr/bin/env python3
"""Tests for scripts/check-staging-deployed-image.py (#1208).

The check runs before staging.yml's integration tests and fails when the staging services don't
run the images this run deployed. Known-good: the scrubbed live staging API describe in
testdata/cloud-run-api-describe.json, checked against its own api image, by tag and by digest.
Known-bad: the same service after another run's deploy replaced the api image, the 2026-11-11 case.

Run locally:  ``python scripts/test_check_staging_deployed_image.py -v``   (no dependencies)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import copy
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("check_image", os.path.join(HERE, "check-staging-deployed-image.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

with open(os.path.join(HERE, "testdata", "cloud-run-api-describe.json"), encoding="utf-8") as f:
    GOOD = json.load(f)

SERVICE = "lifting-logbook-stg-api"
OURS = "us-central1-docker.pkg.dev/example-project/lifting-logbook/api:92a8462616d0ce9010c5dc6165f26392812dc79b"
THEIRS = "us-central1-docker.pkg.dev/example-project/lifting-logbook/api:3c1f0e2b7a9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f"
DIGEST = "sha256:" + "ab" * 32


def with_api_image(image):
    described = copy.deepcopy(GOOD)
    for c in described["spec"]["template"]["spec"]["containers"]:
        if c["name"] == "api":
            c["image"] = image
    return described


class CheckTests(unittest.TestCase):
    def test_own_image_by_tag_passes(self):
        self.assertIsNone(check.mismatch(SERVICE, GOOD, "api", OURS))

    def test_own_image_by_digest_passes(self):
        described = with_api_image(f"us-central1-docker.pkg.dev/example-project/lifting-logbook/api@{DIGEST}")
        self.assertIsNone(check.mismatch(SERVICE, described, "api", OURS, DIGEST))

    def test_sidecar_image_is_not_mistaken_for_the_ingress_container(self):
        self.assertEqual(check.applied_image(GOOD, "api"), OURS)

    def test_another_runs_image_fails_naming_both(self):
        problem = check.mismatch(SERVICE, with_api_image(THEIRS), "api", OURS)
        self.assertIsNotNone(problem)
        self.assertIn(THEIRS, problem)
        self.assertIn(OURS, problem)

    def test_another_runs_image_fails_even_with_a_digest(self):
        self.assertIsNotNone(check.mismatch(SERVICE, with_api_image(THEIRS), "api", OURS, DIGEST))

    def test_missing_ingress_container_fails(self):
        described = copy.deepcopy(GOOD)
        described["spec"]["template"]["spec"]["containers"][0]["name"] = "renamed"
        problem = check.mismatch(SERVICE, described, "api", OURS)
        self.assertIn("<no api container>", problem)

    def test_empty_describe_fails(self):
        self.assertIsNotNone(check.mismatch(SERVICE, {}, "api", OURS))


if __name__ == "__main__":
    unittest.main()
