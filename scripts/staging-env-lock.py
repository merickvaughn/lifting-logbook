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

Priority. Waiters poll with jitter, so without priority whoever polls first after a release wins,
and a merge-queue entry (60-minute queue check timeout) or the post-merge deploy (production waits
on it) could keep losing to PR pushes. A priority waiter (`merge_group` and `push` events) keeps a
marker object fresh while it waits; a `pull_request` waiter does not take the lock while a fresh
marker from another run exists.

The lock object holds the holder's run id, so a holder can re-acquire it (a re-run of failed jobs
keeps its run id) and a release never deletes another run's lock. A lock is taken over, with
`ifGenerationMatch=<its generation>`, when its holder is done (the holder's run has completed, or
for a job-scoped holder such as deploy.yml's deploy-staging, that job has), or when GitHub can't say
and the lock is older than --stale-min. The workflows release in an `always()` job or step.

Usage:
  python3 scripts/staging-env-lock.py acquire --bucket <bucket> [--timeout-min N] [--holder-job NAME]
  python3 scripts/staging-env-lock.py release --bucket <bucket>

--timeout-min 0 never waits: it re-takes a lock this run already holds and otherwise fails at once.
--holder-job names the one job (as GitHub displays it) whose completion ends this hold.

Reads GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW, GITHUB_EVENT_NAME, GITHUB_HEAD_REF,
GITHUB_REF_NAME, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_SERVER_URL, and GH_TOKEN (to ask whether a
holder is done). GCS calls use `gcloud auth print-access-token`, so run it after
google-github-actions/auth.
"""
import argparse
import http.client
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
PRIORITY_EVENTS = {"merge_group", "push"}
# A priority marker older than this belongs to a waiter that stopped (cancelled, crashed): ignore it.
# Waiters refresh their marker every poll, at most poll_s * 1.5 apart (22.5s at the default 15s).
PRIORITY_FRESH_S = 60
# A holder re-taking its own lock rewrites it (to refresh acquired_at) only when it is older than
# this. deploy-api and deploy-web re-take it within seconds of lock-staging, and GCS allows about
# one write per second to one object.
REFRESH_AFTER_S = 300
RETRY_STATUS = {408, 429, 500, 502, 503, 504}


class LockTimeout(Exception):
    pass


class LockError(Exception):
    pass


def describe(holder):
    """One line naming a holder, for logs and error messages."""
    if not holder:
        return "<unknown holder>"
    job = f", job '{holder['job']}'" if holder.get("job") else ""
    return (
        f"run {holder.get('run_id')} ({holder.get('workflow')}, {holder.get('event')} "
        f"on {holder.get('ref')}{job}, {holder.get('url')})"
    )


def is_priority(me):
    return me.get("event") in PRIORITY_EVENTS


def acquire(store, me, holder_done, now, sleep, timeout_s, stale_s, poll_s,
            status_every_s=120, priority_store=None, log=print):
    """Block until `me` holds the lock; return its generation. Raise LockTimeout after timeout_s."""
    deadline = now() + timeout_s
    last_holder = None
    last_logged = None
    last_status_check = float("-inf")
    last_done = None
    priority = is_priority(me) and priority_store is not None
    try:
        while True:
            if priority:
                priority_store.write({"run_id": me["run_id"], "at": now()}, if_generation=None)

            current = store.read()
            if current is not None:
                generation, holder = current
                holder = holder or {}
            else:
                generation, holder = 0, None

            if holder is not None and str(holder.get("run_id")) == str(me["run_id"]):
                # This run already holds it: a later job of the same run, a re-run of failed jobs, or
                # a write whose response was lost.
                if now() - float(holder.get("acquired_at") or 0) < REFRESH_AFTER_S:
                    log(f"This run already holds the staging lock (generation {generation}).")
                    return generation
                taken = store.write(dict(me, acquired_at=now()), if_generation=generation)
                if taken is not None:
                    log(f"This run already held the staging lock; refreshed it (generation {taken}).")
                    return taken
                sleep(2)
                continue

            reason = None
            holder_changed = False
            age = 0.0
            if holder is not None:
                age = now() - float(holder.get("acquired_at") or 0)
                # Ask GitHub about a holder at most every status_every_s: GITHUB_TOKEN's API budget is
                # shared by every job in the repository, and several runs can be waiting at once.
                holder_changed = holder.get("run_id") != (last_holder or {}).get("run_id")
                if holder_changed or now() - last_status_check >= status_every_s:
                    last_status_check = now()
                    last_done = holder_done(holder)
                    if last_done:
                        reason = "it is done but didn't release the lock"
                    elif last_done is None:
                        log(f"::warning::Couldn't ask GitHub whether {describe(holder)} is done; "
                            f"only the {int(stale_s // 60)}-minute age limit can free its lock.")
                # The age limit applies only while GitHub can't say. A holder GitHub reports as still
                # running keeps the lock however old it is: its own job timeouts bound the hold, and
                # taking over from it would redeploy staging under its tests.
                if not reason and last_done is None and age > stale_s:
                    reason = f"it is {int(age // 60)} minutes old, past the {int(stale_s // 60)}-minute limit"

            if holder is None or reason:
                yield_to = None if priority else fresh_priority_waiter(priority_store, me, now)
                if yield_to is None:
                    taken = store.write(dict(me, acquired_at=now()), if_generation=generation)
                    if taken is not None:
                        if reason:
                            log(f"Took over the staging lock from {describe(holder)}: {reason}.")
                        else:
                            log(f"Took the staging lock (generation {taken}).")
                        return taken
                    sleep(2)  # another run wrote it between the read and the write; read again
                    continue
                waiting_for = f"merge-queue or post-merge run {yield_to}, which has priority"
            else:
                waiting_for = describe(holder)

            if now() >= deadline:
                if timeout_s <= 0:
                    raise LockTimeout(
                        f"Staging is held by {waiting_for}, not this run, and this job doesn't wait. "
                        "Re-run all jobs once that run finishes, so this run deploys again."
                    )
                raise LockTimeout(
                    f"Waited {int(timeout_s // 60)} minutes for the staging lock, still waiting for "
                    f"{waiting_for}."
                )
            if waiting_for != last_logged:
                log(f"Staging is held by {waiting_for}; waiting for it to finish.")
                last_logged = waiting_for
            if holder is not None:
                last_holder = holder
            sleep(poll_s + random.uniform(0, poll_s / 2))
    finally:
        if priority:
            clear_priority(priority_store, me)


def fresh_priority_waiter(priority_store, me, now):
    """The run id of another run's fresh priority marker, or None."""
    if priority_store is None:
        return None
    current = priority_store.read()
    if current is None:
        return None
    _, marker = current
    marker = marker or {}
    if str(marker.get("run_id")) == str(me["run_id"]):
        return None
    if now() - float(marker.get("at") or 0) > PRIORITY_FRESH_S:
        return None
    return marker.get("run_id")


def clear_priority(priority_store, me):
    current = priority_store.read()
    if current is None:
        return
    generation, marker = current
    if str((marker or {}).get("run_id")) == str(me["run_id"]):
        priority_store.delete(if_generation=generation)


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
    """One object, through the GCS JSON API with generation preconditions."""

    def __init__(self, bucket, name, opener=urllib.request.urlopen, sleep=time.sleep, token=None):
        self.bucket = bucket
        self.name = name
        self._open = opener
        self._sleep = sleep
        self._token = token
        self._token_at = time.time() if token else 0.0

    def _auth(self):
        # Access tokens last an hour and a wait can approach that, so refresh well before.
        if self._token is None or time.time() - self._token_at > 1200:
            self._token = subprocess.run(
                ["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True
            ).stdout.strip()
            self._token_at = time.time()
        return {"Authorization": f"Bearer {self._token}"}

    def _call(self, method, url, data=None, headers=None):
        """Return (status, headers, body). 404 and 412 are answers; retry transient failures."""
        attempts = 4
        for attempt in range(1, attempts + 1):
            req = urllib.request.Request(url, data=data, method=method, headers={**self._auth(), **(headers or {})})
            try:
                with self._open(req, timeout=30) as resp:
                    return resp.status, resp.headers, resp.read()
            except urllib.error.HTTPError as err:
                if err.code in (404, 412):
                    return err.code, err.headers, err.read()
                if err.code not in RETRY_STATUS or attempt == attempts:
                    body = err.read().decode("utf-8", "replace")[:500]
                    raise LockError(f"GCS {method} {self.name} returned HTTP {err.code}: {body}") from err
                problem = f"HTTP {err.code}"
            except (urllib.error.URLError, http.client.HTTPException, OSError) as err:
                # URLError wraps connection failures; a reset or timeout while reading the response
                # surfaces as http.client.HTTPException or OSError instead.
                if attempt == attempts:
                    raise LockError(f"GCS {method} {self.name} failed: {err}") from err
                problem = str(err)
            delay = attempt * 5 + random.uniform(0, 2)
            print(f"GCS {method} {self.name}: {problem}; retrying in {delay:.0f}s.", file=sys.stderr)
            self._sleep(delay)

    def _object_url(self):
        return f"{GCS}/storage/v1/b/{self.bucket}/o/{urllib.parse.quote(self.name, safe='')}"

    def read(self):
        """Return (generation, content) or None when the object doesn't exist."""
        status, headers, body = self._call("GET", self._object_url() + "?alt=media")
        if status == 404:
            return None
        try:
            content = json.loads(body)
        except ValueError:
            content = {}
        return int(headers["x-goog-generation"]), content

    def write(self, content, if_generation):
        """Write only if the generation matches (0 = absent, None = unconditional).

        Return the new generation, or None if the precondition failed."""
        params = {"uploadType": "media", "name": self.name}
        if if_generation is not None:
            params["ifGenerationMatch"] = if_generation
        url = f"{GCS}/upload/storage/v1/b/{self.bucket}/o?{urllib.parse.urlencode(params)}"
        status, _, body = self._call(
            "POST", url, data=json.dumps(content).encode(), headers={"Content-Type": "application/json"}
        )
        if status == 412:
            return None
        if status == 404:
            raise LockError(f"GCS bucket '{self.bucket}' was not found; check the TF_STATE_BUCKET secret.")
        return int(json.loads(body)["generation"])

    def delete(self, if_generation):
        status, _, _ = self._call("DELETE", f"{self._object_url()}?ifGenerationMatch={if_generation}")
        return status not in (404, 412)


def github_holder_done(holder, opener=urllib.request.urlopen):
    """True if the holder is done, False if not, None if GitHub can't say (then --stale-min applies).

    A run-scoped holder is done when its run has completed. A job-scoped holder (`job` set) is done
    when that job has: deploy.yml's run stays open for hours waiting on production approval after
    its deploy-staging job has released, or failed to release, the lock."""
    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GH_TOKEN")
    run_id = holder.get("run_id")
    if not (repo and token and run_id):
        return None
    path = f"runs/{run_id}/jobs?per_page=100" if holder.get("job") else f"runs/{run_id}"
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
    )
    try:
        with opener(req, timeout=30) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as err:
        print(f"Could not read the status of run {run_id}: {err}", file=sys.stderr)
        return None
    if not holder.get("job"):
        return data.get("status") == "completed"
    jobs = [j for j in data.get("jobs", []) if j.get("name") == holder["job"]]
    if not jobs:
        return None
    return all(j.get("status") == "completed" for j in jobs)


def me_from_env(holder_job=None):
    env = os.environ
    run_id = env.get("GITHUB_RUN_ID")
    if not run_id:
        raise LockError("GITHUB_RUN_ID is not set; this script identifies the lock holder by its workflow run.")
    me = {
        "run_id": run_id,
        "run_attempt": env.get("GITHUB_RUN_ATTEMPT"),
        "workflow": env.get("GITHUB_WORKFLOW"),
        "event": env.get("GITHUB_EVENT_NAME"),
        "ref": env.get("GITHUB_HEAD_REF") or env.get("GITHUB_REF_NAME"),
        "sha": env.get("GITHUB_SHA"),
        "url": f"{env.get('GITHUB_SERVER_URL', 'https://github.com')}/{env.get('GITHUB_REPOSITORY')}/actions/runs/{run_id}",
    }
    if holder_job:
        me["job"] = holder_job
    return me


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("action", choices=["acquire", "release"])
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--object", default=DEFAULT_OBJECT)
    parser.add_argument("--timeout-min", type=float, default=45)
    parser.add_argument("--stale-min", type=float, default=40)
    parser.add_argument("--poll-sec", type=float, default=15)
    parser.add_argument("--holder-job")
    args = parser.parse_args(argv)

    try:
        store = GcsStore(args.bucket, args.object)
        me = me_from_env(args.holder_job)
        if args.action == "release":
            release(store, me)
            return 0
        acquire(
            store, me, github_holder_done, time.time, time.sleep,
            timeout_s=args.timeout_min * 60, stale_s=args.stale_min * 60, poll_s=args.poll_sec,
            priority_store=GcsStore(args.bucket, args.object + ".priority"),
        )
    except LockTimeout as err:
        print(f"::error title=Staging lock timeout::{err} See #1208.")
        return 1
    except LockError as err:
        print(f"::error title=Staging lock error::{err} See #1208.")
        return 1
    except subprocess.CalledProcessError as err:
        print(f"::error title=Staging lock error::{' '.join(err.cmd)} failed: {(err.stderr or '').strip()}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
