#!/usr/bin/env python3
"""Hold the shared staging environment from a run's deploy to the end of its tests (#1208).

Two workflows write the one staging environment: staging.yml (every PR push and merge-queue entry)
and deploy.yml (after each merge). Job-level `concurrency:` groups serialized each deploy, but
nothing held staging between a run's deploy and its integration tests, so a second run could
redeploy staging under the first run's tests. On 2026-11-11 a `pull_request` run did exactly that
50 seconds into a merge-queue run's tests, which then hung until the 25-minute job limit.

A `concurrency:` group cannot be the lock. It lives on one job, and the critical section spans
several (deploy-api and deploy-web in parallel, then the integration tests). It also keeps at most
one pending waiter: a third run cancels the second, which is the #673 starvation pattern. This lock
is a single GCS object instead, created with `ifGenerationMatch=0` so only one run can create it.
Waiters poll until it is free; none is ever cancelled to make room for another.

The object holds the holder's run id, so a holder can re-acquire it (a re-run of failed jobs keeps
its run id) and a release never deletes another run's lock. A lock whose holder run has completed,
or that is older than --stale-min, is taken over with `ifGenerationMatch=<its generation>`, so a
cancelled or crashed run cannot wedge staging. The workflows release in an `always()` job or step.

Usage:
  python3 scripts/staging-env-lock.py acquire --bucket <bucket> [--timeout-min N] [--stale-min N]
  python3 scripts/staging-env-lock.py release --bucket <bucket>

Reads GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW, GITHUB_EVENT_NAME, GITHUB_REF_NAME,
GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_SERVER_URL, and GH_TOKEN (to ask whether a holder's run has
completed). GCS calls use `gcloud auth print-access-token`, so run it after google-github-actions/auth.
"""
import argparse
import json
import os
import random
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_OBJECT = "ci-locks/staging-environment.json"
GCS = "https://storage.googleapis.com"


class LockTimeout(Exception):
    pass


def describe(holder):
    """One line naming a holder, for logs and error messages."""
    if not holder:
        return "<unknown holder>"
    return (
        f"run {holder.get('run_id')} ({holder.get('workflow')}, {holder.get('event')} "
        f"on {holder.get('ref')}, {holder.get('url')})"
    )


def acquire(store, me, run_finished, now, sleep, timeout_s, stale_s, poll_s, status_every_s=120, log=print):
    """Block until `me` holds the lock; return its generation. Raise LockTimeout after timeout_s."""
    deadline = now() + timeout_s
    last_holder = None
    last_status_check = float("-inf")
    while True:
        current = store.read()
        if current is None:
            generation = store.write(dict(me, acquired_at=now()), if_generation=0)
            if generation is not None:
                log(f"Took the staging lock (generation {generation}).")
                return generation
            continue  # another run created it between the read and the write; read again

        generation, holder = current
        holder = holder or {}
        if str(holder.get("run_id")) == str(me["run_id"]):
            # This run already holds it: a re-run of failed jobs, or a write whose response was lost.
            taken = store.write(dict(me, acquired_at=now()), if_generation=generation)
            if taken is not None:
                log(f"This run already held the staging lock; refreshed it (generation {taken}).")
                return taken
            continue

        age = now() - float(holder.get("acquired_at") or 0)
        reason = None
        # Ask GitHub about a holder at most every status_every_s: GITHUB_TOKEN's API budget is
        # shared by every job in the repository, and several runs can be waiting at once.
        holder_changed = holder.get("run_id") != (last_holder or {}).get("run_id")
        check_status = holder_changed or now() - last_status_check >= status_every_s
        if check_status:
            last_status_check = now()
        if check_status and run_finished(holder.get("run_id")):
            reason = "its run has completed without releasing it"
        elif age > stale_s:
            reason = f"it is {int(age // 60)} minutes old, past the {int(stale_s // 60)}-minute limit"
        if reason:
            taken = store.write(dict(me, acquired_at=now()), if_generation=generation)
            if taken is not None:
                log(f"Took over the staging lock from {describe(holder)}: {reason}.")
                return taken
            continue

        if now() >= deadline:
            raise LockTimeout(
                f"Waited {int(timeout_s // 60)} minutes for the staging lock, still held by "
                f"{describe(holder)} for {int(age // 60)} minutes."
            )
        if holder_changed:
            log(f"Staging is held by {describe(holder)}; waiting for it to finish its tests.")
            last_holder = holder
        sleep(poll_s + random.uniform(0, poll_s / 2))


def release(store, me, log=print):
    """Delete the lock if `me` holds it. Return True if this call released it."""
    current = store.read()
    if current is None:
        log("The staging lock is not held; nothing to release.")
        return False
    generation, holder = current
    if str((holder or {}).get("run_id")) != str(me["run_id"]):
        log(f"The staging lock is held by {describe(holder)}, not this run; leaving it.")
        return False
    if store.delete(if_generation=generation):
        log(f"Released the staging lock (generation {generation}).")
        return True
    log("The staging lock changed while releasing it; leaving it.")
    return False


class GcsStore:
    """The lock object, through the GCS JSON API with generation preconditions."""

    def __init__(self, bucket, name):
        self.bucket = bucket
        self.name = name
        self._token = None
        self._token_at = 0.0

    def _auth(self):
        # Access tokens last an hour and a wait can approach that, so refresh well before.
        if self._token is None or time.time() - self._token_at > 1200:
            self._token = subprocess.run(
                ["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True
            ).stdout.strip()
            self._token_at = time.time()
        return {"Authorization": f"Bearer {self._token}"}

    def _call(self, method, url, data=None, headers=None):
        """Return (status, headers, body). 404 and 412 are answers, not errors; retry the rest."""
        for attempt in range(1, 4):
            req = urllib.request.Request(url, data=data, method=method, headers={**self._auth(), **(headers or {})})
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return resp.status, resp.headers, resp.read()
            except urllib.error.HTTPError as err:
                if err.code in (404, 412):
                    return err.code, err.headers, err.read()
                if attempt == 3 or err.code < 500:
                    raise
            except urllib.error.URLError:
                if attempt == 3:
                    raise
            time.sleep(attempt * 5)

    def read(self):
        """Return (generation, holder) or None when the lock is free."""
        url = f"{GCS}/storage/v1/b/{self.bucket}/o/{urllib.parse.quote(self.name, safe='')}?alt=media"
        status, headers, body = self._call("GET", url)
        if status == 404:
            return None
        try:
            holder = json.loads(body)
        except ValueError:
            holder = {}
        return int(headers["x-goog-generation"]), holder

    def write(self, holder, if_generation):
        """Write the lock only if its generation matches (0 = absent). Return the new generation or None."""
        query = urllib.parse.urlencode(
            {"uploadType": "media", "name": self.name, "ifGenerationMatch": if_generation}
        )
        url = f"{GCS}/upload/storage/v1/b/{self.bucket}/o?{query}"
        status, _, body = self._call(
            "POST", url, data=json.dumps(holder).encode(), headers={"Content-Type": "application/json"}
        )
        if status in (404, 412):
            return None
        return int(json.loads(body)["generation"])

    def delete(self, if_generation):
        url = (
            f"{GCS}/storage/v1/b/{self.bucket}/o/{urllib.parse.quote(self.name, safe='')}"
            f"?ifGenerationMatch={if_generation}"
        )
        status, _, _ = self._call("DELETE", url)
        return status not in (404, 412)


def github_run_finished(run_id):
    """True if the run has completed, False if not, None if GitHub can't say (then rely on --stale-min)."""
    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GH_TOKEN")
    if not (repo and token and run_id):
        return None
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/runs/{run_id}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp).get("status") == "completed"
    except (urllib.error.URLError, ValueError) as err:
        print(f"Could not read the status of run {run_id}: {err}", file=sys.stderr)
        return None


def me_from_env():
    env = os.environ
    run_id = env.get("GITHUB_RUN_ID")
    if not run_id:
        sys.exit("GITHUB_RUN_ID is not set; this script identifies the lock holder by its workflow run.")
    return {
        "run_id": run_id,
        "run_attempt": env.get("GITHUB_RUN_ATTEMPT"),
        "workflow": env.get("GITHUB_WORKFLOW"),
        "event": env.get("GITHUB_EVENT_NAME"),
        "ref": env.get("GITHUB_HEAD_REF") or env.get("GITHUB_REF_NAME"),
        "sha": env.get("GITHUB_SHA"),
        "url": f"{env.get('GITHUB_SERVER_URL', 'https://github.com')}/{env.get('GITHUB_REPOSITORY')}/actions/runs/{run_id}",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("action", choices=["acquire", "release"])
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--object", default=DEFAULT_OBJECT)
    parser.add_argument("--timeout-min", type=float, default=45)
    parser.add_argument("--stale-min", type=float, default=90)
    parser.add_argument("--poll-sec", type=float, default=15)
    args = parser.parse_args(argv)

    store = GcsStore(args.bucket, args.object)
    me = me_from_env()
    if args.action == "release":
        release(store, me)
        return 0
    try:
        acquire(
            store, me, github_run_finished, time.time, time.sleep,
            timeout_s=args.timeout_min * 60, stale_s=args.stale_min * 60, poll_s=args.poll_sec,
        )
    except LockTimeout as err:
        print(f"::error title=Staging lock timeout::{err} Re-run the failed jobs once it finishes. See #1208.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
