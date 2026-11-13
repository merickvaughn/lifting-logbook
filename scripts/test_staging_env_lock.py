#!/usr/bin/env python3
"""Tests for scripts/staging-env-lock.py (#1208).

The lock is what keeps a second run from deploying staging while another run's integration tests
are running against it. Most tests drive acquire() and release() against an in-memory store with
GCS's generation-precondition semantics and a fake clock, so the waits are instant and exact. The
concurrency test uses real threads on the same store. The GcsStore and GitHub tests run the real
adapters against a stubbed urlopen, so the HTTP mapping (404/412, retries, the generation header)
is tested rather than assumed.

The two-run case is the 2026-11-11 incident replayed: run A (a merge-queue entry) holds staging
for its tests, run B (a pull_request push) asks for it, and B must not get it until A releases.

Run locally:  ``python scripts/test_staging_env_lock.py -v``   (no dependencies)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import contextlib
import importlib.util
import io
import json
import os
import re
import threading
import time
import unittest
import urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("staging_env_lock", os.path.join(HERE, "staging-env-lock.py"))
lock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lock)


class FakeStore:
    """One object with GCS semantics: writes and deletes succeed only on a matching generation."""

    def __init__(self):
        self.generation = 0  # 0 = absent
        self.content = None
        self.next_generation = 1000
        self.writes = 0
        self.lose_next_create = False
        self.racer_at = 0
        self._mutex = threading.Lock()

    def read(self):
        with self._mutex:
            return None if self.generation == 0 else (self.generation, dict(self.content))

    def write(self, content, if_generation):
        with self._mutex:
            if self.lose_next_create and if_generation == 0:
                # Another run creates the object between this run's read and its write.
                self.lose_next_create = False
                return self._set({"run_id": "racer", "acquired_at": self.racer_at}) and None
            if if_generation is not None and if_generation != self.generation:
                return None
            return self._set(content)

    def delete(self, if_generation):
        with self._mutex:
            if self.generation == 0 or if_generation != self.generation:
                return False
            self.generation, self.content = 0, None
            return True

    def _set(self, content):
        self.writes += 1
        self.next_generation += 1
        self.generation, self.content = self.next_generation, dict(content)
        return self.generation

    @property
    def holder(self):
        return self.content


class Clock:
    def __init__(self):
        self.t = 1_000_000.0
        self.on_sleep = None
        self.sleeps = 0

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.sleeps += 1
        self.t += seconds
        if self.on_sleep:
            self.on_sleep(self)


def run(name, event="pull_request", workflow="Staging", job=None):
    me = {"run_id": name, "workflow": workflow, "event": event, "ref": f"{name}-branch", "url": f"https://x/{name}"}
    if job:
        me["job"] = job
    return me


A = run("101", event="merge_group")
B = run("202")


class LockTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.priority = FakeStore()
        self.clock = Clock()
        self.logs = []
        self.finished = set()

    def acquire(self, me, timeout_s=2700, stale_s=2400, done=None):
        return lock.acquire(
            self.store, me, done or (lambda holder: holder["run_id"] in self.finished),
            self.clock.now, self.clock.sleep, timeout_s=timeout_s, stale_s=stale_s, poll_s=15,
            priority_store=self.priority, log=self.logs.append,
        )

    def release(self, me):
        return lock.release(self.store, me, log=self.logs.append)

    def test_free_lock_is_taken_at_once(self):
        self.acquire(A)
        self.assertEqual(self.store.holder["run_id"], "101")
        self.assertEqual(self.clock.sleeps, 0)

    def test_second_run_waits_until_first_run_releases(self):
        self.acquire(A)  # run A deployed and is running its tests
        acquired_at = self.clock.now()

        def a_finishes_tests_after_five_polls(clock):
            if clock.sleeps == 5:
                self.assertTrue(self.release(A))

        self.clock.on_sleep = a_finishes_tests_after_five_polls
        self.acquire(B)

        self.assertEqual(self.store.holder["run_id"], "202")
        self.assertEqual(self.clock.sleeps, 5, "B must keep waiting while A holds staging")
        self.assertGreater(self.clock.now(), acquired_at)
        self.assertTrue(any("held by run 101" in line for line in self.logs), self.logs)

    def test_concurrent_waiters_all_get_the_lock_in_turn(self):
        # Unlike a concurrency group's single pending slot (#673), a third waiter doesn't displace
        # the second: B and C wait at the same time, and each gets the lock once the holder releases.
        self.acquire(A)
        acquired, errors, overlap = [], [], []
        holding = threading.Lock()

        def waiter(me):
            try:
                lock.acquire(
                    self.store, me, lambda holder: False, time.monotonic, time.sleep,
                    timeout_s=10, stale_s=600, poll_s=0.01, log=lambda line: None,
                )
                if not holding.acquire(blocking=False):
                    overlap.append(me["run_id"])  # two runs inside the lock at once
                    return
                acquired.append(me["run_id"])
                time.sleep(0.05)
                holding.release()
                lock.release(self.store, me, log=lambda line: None)
            except Exception as err:  # surfaced below
                errors.append(err)

        threads = [threading.Thread(target=waiter, args=(run(name),)) for name in ("202", "303")]
        for t in threads:
            t.start()
        time.sleep(0.1)  # both are now polling a held lock
        self.assertEqual(acquired, [], "nobody may get the lock while A holds it")
        self.release(A)
        for t in threads:
            t.join(15)
        self.assertEqual(errors, [])
        self.assertEqual(overlap, [])
        self.assertEqual(sorted(acquired), ["202", "303"])

    def test_lock_of_a_finished_holder_is_taken_over(self):
        self.acquire(A)
        self.finished.add("101")  # A was cancelled or crashed before its release ran
        self.acquire(B)
        self.assertEqual(self.store.holder["run_id"], "202")
        self.assertEqual(self.clock.sleeps, 0)
        self.assertTrue(any("is done" in line for line in self.logs), self.logs)

    def test_young_lock_is_kept_when_github_cannot_say(self):
        self.acquire(A)
        with self.assertRaises(lock.LockTimeout):
            self.acquire(B, timeout_s=600, done=lambda holder: None)
        self.assertEqual(self.store.holder["run_id"], "101")
        self.assertTrue(any("::warning::" in line for line in self.logs), self.logs)

    def test_stale_lock_is_taken_over_when_github_cannot_say(self):
        self.acquire(A)
        self.clock.t += 2401
        self.acquire(B, done=lambda holder: None)
        self.assertEqual(self.store.holder["run_id"], "202")
        self.assertTrue(any("past the 40-minute limit" in line for line in self.logs), self.logs)

    def test_old_lock_of_a_running_holder_is_kept(self):
        # GitHub says A is still running: past the age limit or not, taking over would redeploy
        # staging under A's tests.
        self.acquire(A)
        self.clock.t += 2401
        with self.assertRaises(lock.LockTimeout):
            self.acquire(B, timeout_s=600, done=lambda holder: False)
        self.assertEqual(self.store.holder["run_id"], "101")

    def test_same_run_reacquires_without_rewriting_a_young_lock(self):
        self.acquire(A)
        writes = self.store.writes
        self.acquire(dict(A, run_attempt="2"), timeout_s=0)
        self.assertEqual(self.store.writes, writes, "deploy-api and deploy-web re-take it at once")
        self.assertEqual(self.clock.sleeps, 0)

    def test_same_run_refreshes_an_old_lock(self):
        self.acquire(A)
        self.clock.t += 600
        self.acquire(dict(A, run_attempt="2"), timeout_s=0)
        self.assertEqual(self.store.holder["run_attempt"], "2")
        self.assertEqual(self.store.holder["acquired_at"], self.clock.now())

    def test_no_wait_retake_fails_at_once_when_another_run_holds_it(self):
        self.acquire(A)
        with self.assertRaises(lock.LockTimeout) as ctx:
            self.acquire(B, timeout_s=0)
        self.assertEqual(self.clock.sleeps, 0)
        self.assertIn("doesn't wait", str(ctx.exception))
        self.assertIn("Re-run all jobs", str(ctx.exception))

    def test_lost_create_race_reads_again_and_waits(self):
        self.store.lose_next_create = True
        self.store.racer_at = self.clock.now()
        self.clock.on_sleep = lambda clock: clock.sleeps == 2 and setattr(self.store, "generation", 0)
        self.acquire(B)
        self.assertEqual(self.store.holder["run_id"], "202")

    def test_timeout_names_the_holder(self):
        self.acquire(A)
        with self.assertRaises(lock.LockTimeout) as ctx:
            self.acquire(B, timeout_s=60)
        self.assertIn("run 101", str(ctx.exception))
        self.assertIn("merge_group", str(ctx.exception))

    def test_pull_request_waiter_yields_to_a_waiting_merge_queue_run(self):
        self.acquire(B)  # a PR run holds staging
        C = run("303")  # another PR push
        Q = run("404", event="merge_group")
        # The queue entry starts waiting: it writes its priority marker.
        with self.assertRaises(lock.LockTimeout):
            self.acquire(Q, timeout_s=0)
        self.priority.write({"run_id": "404", "at": self.clock.now()}, if_generation=None)
        self.release(B)
        # The lock is free, but C must not take it while the queue entry's marker is fresh.
        with self.assertRaises(lock.LockTimeout) as ctx:
            self.acquire(C, timeout_s=30)
        self.assertIn("404", str(ctx.exception))
        self.assertIsNone(self.store.read())
        self.priority.write({"run_id": "404", "at": self.clock.now()}, if_generation=None)
        self.acquire(Q)
        self.assertEqual(self.store.holder["run_id"], "404")
        self.assertIsNone(self.priority.read(), "the queue entry clears its marker once it holds the lock")

    def test_stale_priority_marker_is_ignored(self):
        self.priority.write({"run_id": "404", "at": self.clock.now() - 120}, if_generation=None)
        self.acquire(B)
        self.assertEqual(self.store.holder["run_id"], "202")

    def test_priority_marker_is_cleared_on_timeout(self):
        self.acquire(B)
        with self.assertRaises(lock.LockTimeout):
            self.acquire(run("404", event="push", workflow="Deploy"), timeout_s=60)
        self.assertIsNone(self.priority.read())

    def test_release_leaves_another_runs_lock(self):
        self.acquire(A)
        self.assertFalse(self.release(B))
        self.assertEqual(self.store.holder["run_id"], "101")

    def test_release_of_a_free_lock_is_a_no_op(self):
        self.assertFalse(self.release(B))

    def test_github_is_asked_about_a_holder_at_most_every_two_minutes(self):
        self.acquire(A)
        asked = []

        def done(holder):
            asked.append(self.clock.now())
            return False

        self.clock.on_sleep = lambda clock: clock.sleeps == 40 and self.release(A)
        self.acquire(B, done=done)
        gaps = [later - earlier for earlier, later in zip(asked, asked[1:])]
        self.assertTrue(gaps, "expected repeated status checks over 40 polls")
        self.assertTrue(all(gap >= 120 for gap in gaps), gaps)


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self.headers = headers or {}
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code, body=b"{}"):
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO(body))


class Opener:
    """A urlopen stand-in that plays back a script of responses or exceptions."""

    def __init__(self, *script):
        self.script = list(script)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def gcs(*script):
    opener = Opener(*script)
    return lock.GcsStore("bucket", "ci-locks/x.json", opener=opener, sleep=lambda s: None, token="t"), opener


class GcsStoreTests(unittest.TestCase):
    def test_read_of_a_missing_object_is_none(self):
        store, _ = gcs(http_error(404))
        self.assertIsNone(store.read())

    def test_read_returns_the_generation_header_and_content(self):
        store, opener = gcs(FakeResponse(body=b'{"run_id": "7"}', headers={"x-goog-generation": "42"}))
        self.assertEqual(store.read(), (42, {"run_id": "7"}))
        self.assertIn("ci-locks%2Fx.json?alt=media", opener.requests[0].full_url)

    def test_create_sends_the_generation_precondition(self):
        store, opener = gcs(FakeResponse(body=b'{"generation": "43"}'))
        self.assertEqual(store.write({"run_id": "7"}, if_generation=0), 43)
        self.assertIn("ifGenerationMatch=0", opener.requests[0].full_url)

    def test_unconditional_write_sends_no_precondition(self):
        store, opener = gcs(FakeResponse(body=b'{"generation": "44"}'))
        store.write({"run_id": "7"}, if_generation=None)
        self.assertNotIn("ifGenerationMatch", opener.requests[0].full_url)

    def test_failed_precondition_is_none(self):
        store, _ = gcs(http_error(412))
        self.assertIsNone(store.write({}, if_generation=0))

    def test_missing_bucket_raises_instead_of_spinning(self):
        store, _ = gcs(http_error(404))
        with self.assertRaises(lock.LockError) as ctx:
            store.write({}, if_generation=0)
        self.assertIn("ci-locks.tf", str(ctx.exception))

    def test_missing_bucket_is_recreated_then_the_write_retried(self):
        store, opener = gcs(
            http_error(404), FakeResponse(body=b'{"name": "bucket"}'), FakeResponse(body=b'{"generation": "46"}'),
        )
        store.recreate_in_project = "stg-project"
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(store.write({"run_id": "7"}, if_generation=0), 46)
        create = opener.requests[1]
        self.assertTrue(create.full_url.endswith("/storage/v1/b?project=stg-project"))
        spec = json.loads(create.data)
        self.assertEqual(spec["name"], "bucket")
        self.assertEqual(spec["versioning"], {"enabled": False})
        self.assertEqual(spec["softDeletePolicy"], {"retentionDurationSeconds": "0"})
        self.assertIn("ifGenerationMatch=0", opener.requests[2].full_url)
        self.assertIn("::warning title=Staging lock bucket recreated::", out.getvalue())

    def test_recreated_bucket_matches_the_terraform_definition(self):
        # The next staging apply imports a recreated bucket. A setting that differs from ci-locks.tf
        # would show up there as a change (or a replacement, for location), so keep the two in step.
        store, opener = gcs(http_error(404), FakeResponse(body=b"{}"), FakeResponse(body=b'{"generation": "1"}'))
        store.recreate_in_project = "p"
        with contextlib.redirect_stdout(io.StringIO()):
            store.write({}, if_generation=0)
        spec = json.loads(opener.requests[1].data)
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "infra", "terraform")
        with open(os.path.join(root, "ci-locks.tf"), encoding="utf-8") as f:
            tf = f.read()
        with open(os.path.join(root, "variables.tf"), encoding="utf-8") as f:
            region = re.search(r'variable "region" \{.*?default\s*=\s*"([^"]+)"', f.read(), re.S).group(1)
        self.assertRegex(tf, r"location\s*=\s*var\.region")
        self.assertEqual(spec["location"].lower(), region)
        self.assertFalse(spec["versioning"]["enabled"])
        self.assertRegex(tf, r"versioning\s*\{\s*enabled\s*=\s*false\s*\}")
        self.assertRegex(
            tf, r"retention_duration_seconds\s*=\s*%s\b" % spec["softDeletePolicy"]["retentionDurationSeconds"]
        )
        self.assertEqual(spec["iamConfiguration"]["uniformBucketLevelAccess"], {"enabled": True})
        self.assertRegex(tf, r"uniform_bucket_level_access\s*=\s*true")
        self.assertRegex(tf, r'public_access_prevention\s*=\s*"%s"' % spec["iamConfiguration"]["publicAccessPrevention"])

    def test_bucket_created_by_another_run_meanwhile_is_fine(self):
        store, opener = gcs(http_error(404), http_error(409), FakeResponse(body=b'{"generation": "47"}'))
        store.recreate_in_project = "stg-project"
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(store.write({}, if_generation=0), 47)
        self.assertEqual(len(opener.requests), 3)

    def test_failed_recreate_is_a_lock_error(self):
        store, opener = gcs(http_error(404), http_error(403, b'{"error": "storage.buckets.create denied"}'))
        store.recreate_in_project = "stg-project"
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(lock.LockError) as ctx:
            store.write({}, if_generation=0)
        self.assertIn("storage.buckets.create denied", str(ctx.exception))
        self.assertIn("/storage/v1/b?project=stg-project", opener.requests[1].full_url)

    def test_throttling_server_errors_and_resets_are_retried(self):
        store, opener = gcs(
            http_error(429), http_error(503), ConnectionResetError("reset"),
            FakeResponse(body=b'{"generation": "45"}'),
        )
        self.assertEqual(store.write({}, if_generation=0), 45)
        self.assertEqual(len(opener.requests), 4)

    def test_permission_error_is_not_retried_and_names_the_body(self):
        store, opener = gcs(http_error(403, b'{"error": "storage.objects.create denied"}'))
        with self.assertRaises(lock.LockError) as ctx:
            store.read()
        self.assertEqual(len(opener.requests), 1)
        self.assertIn("storage.objects.create denied", str(ctx.exception))

    def test_persistent_network_failure_raises_lock_error(self):
        store, _ = gcs(*[TimeoutError("timed out")] * 4)
        with self.assertRaises(lock.LockError):
            store.read()

    def test_delete_reports_whether_it_deleted(self):
        store, _ = gcs(FakeResponse(status=204), http_error(412))
        self.assertTrue(store.delete(if_generation=1))
        self.assertFalse(store.delete(if_generation=1))


class GitHubHolderDoneTests(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict(os.environ, {"GITHUB_REPOSITORY": "o/r", "GH_TOKEN": "t"})
        env.start()
        self.addCleanup(env.stop)

    def done(self, holder, *script):
        return lock.github_holder_done(holder, opener=Opener(*script))

    def test_run_scoped_holder_is_done_when_its_run_completed(self):
        self.assertTrue(self.done(run("1"), FakeResponse(body=b'{"status": "completed"}')))
        self.assertFalse(self.done(run("1"), FakeResponse(body=b'{"status": "in_progress"}')))

    def test_job_scoped_holder_is_done_when_its_job_completed_though_the_run_waits(self):
        jobs = {"jobs": [
            {"name": "Deploy (staging)", "status": "completed"},
            {"name": "Deploy (production)", "status": "waiting"},
        ]}
        holder = run("1", event="push", workflow="Deploy", job="Deploy (staging)")
        self.assertTrue(self.done(holder, FakeResponse(body=json.dumps(jobs).encode())))

    def test_job_scoped_holder_with_its_job_running_is_not_done(self):
        jobs = {"jobs": [{"name": "Deploy (staging)", "status": "in_progress"}]}
        holder = run("1", event="push", workflow="Deploy", job="Deploy (staging)")
        self.assertFalse(self.done(holder, FakeResponse(body=json.dumps(jobs).encode())))

    def test_unreadable_status_is_none(self):
        self.assertIsNone(self.done(run("1"), TimeoutError("timed out")))
        self.assertIsNone(self.done(run("1"), http_error(403)))


class MainTests(unittest.TestCase):
    def test_gcs_error_is_an_annotation_not_a_traceback(self):
        env = {"GITHUB_RUN_ID": "1", "GITHUB_REPOSITORY": "o/r"}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(lock.GcsStore, "read", side_effect=lock.LockError("GCS GET returned HTTP 403")):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = lock.main(["release", "--bucket", "b"])
        self.assertEqual(code, 1)
        self.assertIn("::error title=Staging lock error::GCS GET returned HTTP 403", out.getvalue())

    def test_recreate_project_reaches_the_lock_and_priority_stores(self):
        env = {"GITHUB_RUN_ID": "1", "GITHUB_REPOSITORY": "o/r"}
        with mock.patch.dict(os.environ, env), mock.patch.object(lock, "acquire") as acquire:
            code = lock.main(["acquire", "--bucket", "b", "--recreate-in-project", "p"])
        self.assertEqual(code, 0)
        store = acquire.call_args.args[0]
        self.assertEqual(store.recreate_in_project, "p")
        self.assertEqual(acquire.call_args.kwargs["priority_store"].recreate_in_project, "p")


if __name__ == "__main__":
    unittest.main()
