#!/usr/bin/env python3
"""Fail unless a Cloud Run service sends 100% of its traffic to its newest revision (#1042).

Reads `gcloud run services describe <svc> --format=json` (from a path argument, else stdin) and
exits non-zero, printing one GitHub `::error::` line per problem, unless all of these hold:

  * `status.observedGeneration` equals `metadata.generation` — the status describes the spec
    that was just applied, not an older one;
  * `status.latestReadyRevisionName` equals `status.latestCreatedRevisionName` — the revision the
    deploy just created became ready;
  * the entries of `status.traffic` routed to that revision sum to 100%;
  * with `--image`, one of the `spec.template` containers runs exactly that image.

Together these prove the URL is answering from the revision this deploy created, running the
image it deployed. The check exists because a manual `update-traffic --to-revisions` rollback
pinned staging's API to one July revision for three months: every deploy created a 0%-traffic
revision, and every check that looked at `spec.template` or probed `/readyz` still passed.

A missing or empty `status.traffic` is a failure, never a pass: summing nothing would otherwise
report a confident "0%" mismatch at best, or nothing at all.

Usage:
  gcloud run services describe <svc> --region <r> --project <p> --format=json \\
    | python3 scripts/check-cloud-run-serving-revision.py --image <registry>/api:<sha>
"""
import argparse
import json
import sys


def problems(svc, expected_image=None):
    """Return a list of human-readable problems; empty means the newest revision serves 100%."""
    name = (svc.get("metadata") or {}).get("name", "<unnamed service>")
    status = svc.get("status") or {}
    found = []

    generation = (svc.get("metadata") or {}).get("generation")
    observed = status.get("observedGeneration")
    if generation is None or observed != generation:
        found.append(
            f"{name}: status.observedGeneration ({observed}) does not match metadata.generation "
            f"({generation}); the status does not describe the spec that was just applied."
        )

    created = status.get("latestCreatedRevisionName")
    ready = status.get("latestReadyRevisionName")
    if not created or ready != created:
        found.append(
            f"{name}: the newest revision {created} is not ready (latest ready revision: {ready})."
        )

    traffic = status.get("traffic") or []
    if not traffic:
        found.append(f"{name}: status.traffic is missing or empty, so it cannot tell which revision serves.")
    else:
        # status.traffic fills in revisionName even for `latestRevision: true` entries; fall back to
        # the latestRevision flag only if a response ever omits it.
        serving = sum(
            int(t.get("percent") or 0)
            for t in traffic
            if t.get("revisionName") == ready or (t.get("latestRevision") and not t.get("revisionName"))
        )
        if serving != 100:
            routes = ", ".join(
                f"{t.get('revisionName') or 'latest'}={t.get('percent') or 0}%" for t in traffic
            )
            found.append(
                f"{name}: {serving}% of traffic goes to the newest revision {ready} (routes: {routes}). "
                "Traffic is pinned to an older revision; see docs/runbooks/deploy-regression-rollback.md."
            )

    if expected_image:
        containers = (((svc.get("spec") or {}).get("template") or {}).get("spec") or {}).get("containers") or []
        images = [c.get("image") for c in containers]
        if expected_image not in images:
            found.append(f"{name}: no container runs {expected_image} (images: {', '.join(map(str, images))}).")

    return found


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("path", nargs="?", default="-", help="describe JSON file (default: stdin)")
    parser.add_argument("--image", help="image the newest revision must run")
    args = parser.parse_args()

    text = sys.stdin.read() if args.path == "-" else open(args.path, encoding="utf-8").read()
    try:
        svc = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"::error title=Cloud Run serving check::could not parse describe JSON: {e}")
        return 1

    found = problems(svc, args.image)
    for p in found:
        print(f"::error title=Cloud Run is not serving the new revision::{p}")
    if found:
        return 1
    ready = svc["status"]["latestReadyRevisionName"]
    # ASCII only: on a Windows console or pipe, stdout is cp1252 and cannot encode a check mark.
    print(f"OK {svc['metadata']['name']}: 100% of traffic is served by {ready}, the revision this deploy created.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
