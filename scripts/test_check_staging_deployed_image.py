#!/usr/bin/env python3
"""Tests for scripts/check-staging-deployed-image.py (#1208).

The check runs before staging.yml's integration tests and fails when the staging services don't
run the images this run deployed. Known-good: the scrubbed live staging API describe in
testdata/cloud-run-api-describe.json, checked against its own api image, by tag and by digest.
Known-bad: the same service after another run's deploy replaced the api image. That is the
2026-11-11 case, and PR #1215's own first staging run hit it for real: a `pull_request` run on a
branch without the lock redeployed stg-web, and this check failed in 14s naming both images.

Run locally:  ``python scripts/test_check_staging_deployed_image.py -v``   (no dependencies)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("check_image", os.path.join(HERE, "check-staging-deployed-image.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

with open(os.path.join(HERE, "testdata", "cloud-run-api-describe.json"), encoding="utf-8") as f:
    GOOD = json.load(f)

SERVICE = "lifting-logbook-stg-api"
REPO = "us-central1-docker.pkg.dev/example-project/lifting-logbook"
TAG = "92a8462616d0ce9010c5dc6165f26392812dc79b"
OURS = f"{REPO}/api:{TAG}"
THEIRS = f"{REPO}/api:3c1f0e2b7a9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f"
DIGEST = "sha256:" + "ab" * 32


def with_api_image(image, described=GOOD):
    described = copy.deepcopy(described)
    for c in described["spec"]["template"]["spec"]["containers"]:
        if c["name"] == "api":
            c["image"] = image
    return described


def as_web(described):
    """The api fixture reshaped into the web service: container `web`, image web:<tag>."""
    described = copy.deepcopy(described)
    for c in described["spec"]["template"]["spec"]["containers"]:
        if c["name"] == "api":
            c["name"] = "web"
            c["image"] = c["image"].replace("/api:", "/web:")
    return described


class MismatchTests(unittest.TestCase):
    def test_own_image_by_tag_passes(self):
        self.assertIsNone(check.mismatch(SERVICE, GOOD, "api", OURS))

    def test_own_image_by_digest_passes(self):
        described = with_api_image(f"{REPO}/api@{DIGEST}")
        self.assertIsNone(check.mismatch(SERVICE, described, "api", OURS, DIGEST))

    def test_ingress_container_is_found_by_name_not_position(self):
        described = copy.deepcopy(GOOD)
        described["spec"]["template"]["spec"]["containers"].reverse()  # sidecar first
        self.assertEqual(check.applied_image(described, "api"), OURS)
        self.assertIsNone(check.mismatch(SERVICE, described, "api", OURS))

    def test_another_runs_image_fails_naming_both(self):
        problem = check.mismatch(SERVICE, with_api_image(THEIRS), "api", OURS)
        self.assertIsNotNone(problem)
        self.assertIn(THEIRS, problem)
        self.assertIn(OURS, problem)
        self.assertIn("Another run deployed staging", problem)

    def test_another_runs_image_fails_even_with_a_digest(self):
        self.assertIsNotNone(check.mismatch(SERVICE, with_api_image(THEIRS), "api", OURS, DIGEST))

    def test_digest_pin_with_unresolved_digest_does_not_blame_another_run(self):
        problem = check.mismatch(SERVICE, with_api_image(f"{REPO}/api@{DIGEST}"), "api", OURS, None, digest_unknown=True)
        self.assertIn("couldn't be resolved", problem)
        self.assertNotIn("Another run deployed staging", problem)

    def test_missing_ingress_container_fails(self):
        described = copy.deepcopy(GOOD)
        described["spec"]["template"]["spec"]["containers"][0]["name"] = "renamed"
        problem = check.mismatch(SERVICE, described, "api", OURS)
        self.assertIn("<no api container>", problem)

    def test_empty_describe_fails(self):
        self.assertIsNotNone(check.mismatch(SERVICE, {}, "api", OURS))


class FakeGcloud:
    """subprocess.run stand-in: maps a service name to a list of describe results to play back."""

    def __init__(self, describes, digest=None):
        self.describes = {k: list(v) for k, v in describes.items()}
        self.digest = digest
        self.calls = []

    def __call__(self, cmd, capture_output=True, text=True):
        self.calls.append(cmd)
        if cmd[1] == "artifacts":
            if self.digest is None:
                return subprocess.CompletedProcess(cmd, 1, "", "PERMISSION_DENIED")
            return subprocess.CompletedProcess(cmd, 0, json.dumps({"image_summary": {"digest": self.digest}}), "")
        result = self.describes[cmd[4]].pop(0)
        if isinstance(result, str):
            return subprocess.CompletedProcess(cmd, 1, "", result)
        return subprocess.CompletedProcess(cmd, 0, json.dumps(result), "")


def run_main(fake):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = check.main(
            ["--project=p", "--region=r", f"--ar-repo={REPO}", f"--tag={TAG}", "--when=before the tests"],
            run=fake, sleep=lambda s: None,
        )
    return code, out.getvalue()


class MainTests(unittest.TestCase):
    def test_both_services_on_this_runs_images_pass(self):
        code, out = run_main(FakeGcloud({"lifting-logbook-stg-api": [GOOD], "lifting-logbook-stg-web": [as_web(GOOD)]}))
        self.assertEqual(code, 0, out)
        self.assertNotIn("::error", out)

    def test_overwritten_web_fails_with_the_annotation(self):
        theirs = with_api_image(THEIRS)
        code, out = run_main(FakeGcloud(
            {"lifting-logbook-stg-api": [GOOD], "lifting-logbook-stg-web": [as_web(theirs)]}, digest=DIGEST
        ))
        self.assertEqual(code, 1)
        self.assertIn("::error title=Staging is not running this run's build (before the tests)::", out)
        self.assertIn(THEIRS.replace("/api:", "/web:"), out)

    def test_transient_describe_failure_is_retried(self):
        fake = FakeGcloud({"lifting-logbook-stg-api": ["503 unavailable", GOOD], "lifting-logbook-stg-web": [as_web(GOOD)]})
        code, out = run_main(fake)
        self.assertEqual(code, 0, out)

    def test_persistent_describe_failure_says_it_could_not_read(self):
        fake = FakeGcloud({"lifting-logbook-stg-api": ["403 denied"] * 3, "lifting-logbook-stg-web": [as_web(GOOD)]})
        code, out = run_main(fake)
        self.assertEqual(code, 1)
        self.assertIn("::error title=Couldn't read the staging services", out)
        self.assertIn("403 denied", out)
        self.assertNotIn("Another run deployed staging", out)


if __name__ == "__main__":
    unittest.main()
