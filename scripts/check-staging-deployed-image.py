#!/usr/bin/env python3
"""Fail unless the staging api and web services run the images this workflow run deployed (#1208).

staging.yml's integration tests run against the shared staging services. The staging lock
(scripts/staging-env-lock.py) keeps other runs from redeploying them between this run's deploy and
the end of its tests; this check proves it held. Without it, a run whose build was replaced tested
someone else's code, and on 2026-11-11 hung until the 25-minute job limit instead of failing.

For each service, it reads `gcloud run services describe --format=json` and compares the ingress
container's image in spec.template (what was applied last) with the image this run passed to the
deploy. If the tag doesn't match, it accepts the same image by digest. A mismatch fails with an
`::error::` naming both images.

It checks what was applied, not what serves: the deploy action's "Verify the newest revision
serves 100% of traffic" step (scripts/check-cloud-run-serving-revision.py) already proves the
newest revision serves.

Usage:
  python3 scripts/check-staging-deployed-image.py --project <p> --region <r> \\
    --ar-repo <registry/project/repo> --tag <image-tag> [--when "before the tests"]
"""
import argparse
import json
import subprocess
import sys
import time

# Cloud Run service name -> its ingress container, which is also the image's name in the registry.
SERVICES = {
    "lifting-logbook-stg-api": "api",
    "lifting-logbook-stg-web": "web",
}


def applied_image(described, container):
    """The image of `container` in the service's spec.template, or None."""
    containers = (((described.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or []
    for c in containers:
        if c.get("name") == container:
            return c.get("image")
    return None


def mismatch(service, described, container, expected, expected_digest=None, digest_unknown=False):
    """Return an error message, or None when the service runs `expected` (by tag or digest)."""
    live = applied_image(described, container)
    if live == expected:
        return None
    if live and expected_digest and expected_digest in live:
        return None
    if live and "@sha256:" in live and digest_unknown:
        # A digest-pinned image can't be told apart from ours without our image's digest.
        return (
            f"{service} runs '{live}', pinned by digest, and the digest of this run's image "
            f"'{expected}' couldn't be resolved, so the check can't tell whether it is this run's build. "
            "Re-run the failed jobs; if it repeats, check Artifact Registry access."
        )
    by_digest = f" ({expected_digest})" if expected_digest else ""
    return (
        f"{service} runs '{live or '<no ' + container + ' container>'}', but this run deployed "
        f"'{expected}'{by_digest}. Another run deployed staging after this one, so these tests would "
        "run against a build that isn't theirs. The staging lock should prevent this; see #1208 and "
        "CLAUDE.md 'Staging overwritten mid-test'."
    )


class GcloudError(Exception):
    pass


def gcloud_json(args, run=subprocess.run, sleep=time.sleep, attempts=3):
    """Run a gcloud read, retrying transient failures; raise GcloudError with its stderr."""
    for attempt in range(1, attempts + 1):
        proc = run(["gcloud", *args, "--format=json"], capture_output=True, text=True)
        if proc.returncode == 0:
            return json.loads(proc.stdout)
        if attempt == attempts:
            raise GcloudError(f"gcloud {' '.join(args[:3])} failed after {attempts} attempts: {proc.stderr.strip()}")
        print(f"gcloud {' '.join(args[:3])} attempt {attempt} failed; retrying in {attempt * 5}s.", file=sys.stderr)
        sleep(attempt * 5)


def digest_of(image, project, run=subprocess.run, sleep=time.sleep):
    try:
        described = gcloud_json(
            ["artifacts", "docker", "images", "describe", image, f"--project={project}"], run=run, sleep=sleep
        )
    except (GcloudError, ValueError):
        return None
    return (described.get("image_summary") or {}).get("digest")


def main(argv=None, run=subprocess.run, sleep=time.sleep):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--ar-repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--when", default="")
    args = parser.parse_args(argv)
    when = f" ({args.when})" if args.when else ""

    failed = False
    for service, container in SERVICES.items():
        expected = f"{args.ar_repo}/{container}:{args.tag}"
        try:
            described = gcloud_json(
                ["run", "services", "describe", service, f"--region={args.region}", f"--project={args.project}"],
                run=run, sleep=sleep,
            )
        except (GcloudError, ValueError) as err:
            print(f"::error title=Couldn't read the staging services{when}::{err} This is not evidence of "
                  "another run's deploy; re-run the failed jobs.")
            failed = True
            continue
        problem = mismatch(service, described, container, expected)
        if problem:
            # Only look up the digest when the tag differs, as the deploy job's own check does.
            digest = digest_of(expected, args.project, run=run, sleep=sleep)
            problem = mismatch(service, described, container, expected, digest, digest_unknown=digest is None)
        if problem:
            print(f"::error title=Staging is not running this run's build{when}::{problem}")
            failed = True
        else:
            print(f"{service} runs this run's image {expected}.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
