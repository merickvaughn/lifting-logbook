#!/usr/bin/env python3
"""Fail unless a Cloud Run service sends 100% of its traffic to its newest ready revision (#1042).

Reads `gcloud run services describe <svc> --format=json` (from a path argument, else stdin) and
exits non-zero, printing one GitHub `::error::` line per problem, unless the entries of
`status.traffic` routed to `status.latestReadyRevisionName` sum to 100%.

That is the property a pin violates. A manual `update-traffic --to-revisions` rollback pinned
staging's API to one July revision for three months: every deploy created a newer ready revision
at 0% traffic, and every check that looked at `spec.template` or probed `/readyz` still passed.

The check deliberately asks nothing else. The staging services are written by two workflows
(staging.yml per PR and merge-queue entry, deploy.yml after each merge) that do not share a lock,
so by the time this runs another deploy may have replaced the service, or may still be rolling
out. Comparing images, generations, or created-vs-ready revisions would fail the slower deploy
for that, not for a pin. Traffic on the newest ready revision holds through both cases; a pin
breaks it every time.

A missing or empty `status.traffic`, or no `latestReadyRevisionName`, is a failure, never a pass:
with nothing to compare there is nothing to prove.

Usage:
  gcloud run services describe <svc> --region <r> --project <p> --format=json \\
    | python3 scripts/check-cloud-run-serving-revision.py
"""
import json
import sys


def problems(svc):
    """Return a list of human-readable problems; empty means the newest ready revision serves 100%."""
    name = (svc.get("metadata") or {}).get("name", "<unnamed service>")
    status = svc.get("status") or {}
    ready = status.get("latestReadyRevisionName")
    traffic = status.get("traffic") or []

    if not ready:
        return [f"{name}: status.latestReadyRevisionName is missing, so no revision is known to be ready."]
    if not traffic:
        return [f"{name}: status.traffic is missing or empty, so it cannot tell which revision serves."]

    # status.traffic fills in revisionName even for `latestRevision: true` entries; fall back to the
    # latestRevision flag only if a response ever omits it.
    serving = sum(
        int(t.get("percent") or 0)
        for t in traffic
        if t.get("revisionName") == ready or (t.get("latestRevision") and not t.get("revisionName"))
    )
    if serving == 100:
        return []
    routes = ", ".join(f"{t.get('revisionName') or 'latest'}={t.get('percent') or 0}%" for t in traffic)
    return [
        f"{name}: {serving}% of traffic goes to the newest ready revision {ready} (routes: {routes}). "
        "Traffic is pinned to an older revision; see docs/runbooks/deploy-regression-rollback.md."
    ]


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    text = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    try:
        svc = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"::error title=Cloud Run serving check::could not parse describe JSON: {e}")
        return 1

    found = problems(svc)
    for p in found:
        print(f"::error title=Cloud Run is not serving its newest revision::{p}")
    if found:
        return 1
    # ASCII only: on a Windows console or pipe, stdout is cp1252 and cannot encode a check mark.
    print(f"OK {svc['metadata']['name']}: 100% of traffic is served by {svc['status']['latestReadyRevisionName']}, its newest ready revision.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
