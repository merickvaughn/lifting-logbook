#!/usr/bin/env python3
"""Tests for scripts/staging-env-lock.py (#1208).

The lock is what keeps a second run from deploying staging while another run's integration tests
are running against it. These tests drive acquire() and release() against an in-memory store with
GCS's generation-precondition semantics and a fake clock, so the waits are instant and exact.

The two-run case is the 2026-11-11 incident replayed: run A (a merge-queue entry) holds staging
for its tests, run B (a pull_request push) asks for it, and B must not get it until A releases.

Run locally:  ``python scripts/test_staging_env_lock.py -v``   (no dependencies)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("staging_env_lock", os.path.join(HERE, "staging-env-lock.py"))
lock = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lock)


class FakeStore:
    """One object with GCS semantics: writes and deletes succeed only on a matching generation."""

    def __init__(self):
        self.generation = 0  # 0 = absent
        self.holder = None
        self.next_generation = 1000
        self.lose_next_create = False
        self.racer_at = 0

    def read(self):
        return None if self.generation == 0 else (self.generation, dict(self.holder))

    def write(self, holder, if_generation):
        if self.lose_next_create and if_generation == 0:
            # Another run creates the object between this run's read and its write.
            self.lose_next_create = False
            self._set({"run_id": "racer", "acquired_at": self.racer_at})
            return None
        if if_generation != self.generation:
            return None
        return self._set(holder)

    def delete(self, if_generation):
        if self.generation == 0 or if_generation != self.generation:
            return False
        self.generation, self.holder = 0, None
        return True

    def _set(self, holder):
        self.next_generation += 1
        self.generation, self.holder = self.next_generation, dict(holder)
        return self.generation


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


def run(name, workflow="Staging", event="pull_request"):
    return {"run_id": name, "workflow": workflow, "event": event, "ref": f"{name}-branch", "url": f"https://x/{name}"}


A = run("101", event="merge_group")
B = run("202")


class LockTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.clock = Clock()
        self.logs = []
        self.finished = set()

    def acquire(self, me, timeout_s=2700, stale_s=5400):
        return lock.acquire(
            self.store, me, lambda run_id: run_id in self.finished, self.clock.now, self.clock.sleep,
            timeout_s=timeout_s, stale_s=stale_s, poll_s=15, log=self.logs.append,
        )

    def test_free_lock_is_taken_at_once(self):
        self.acquire(A)
        self.assertEqual(self.store.holder["run_id"], "101")
        self.assertEqual(self.clock.sleeps, 0)

    def test_second_run_waits_until_first_run_releases(self):
        self.acquire(A)  # run A deployed and is running its tests
        acquired_at = self.clock.now()

        def a_finishes_tests_after_five_polls(clock):
            if clock.sleeps == 5:
                self.assertTrue(lock.release(self.store, A, log=self.logs.append))

        self.clock.on_sleep = a_finishes_tests_after_five_polls
        self.acquire(B)

        self.assertEqual(self.store.holder["run_id"], "202")
        self.assertEqual(self.clock.sleeps, 5, "B must keep waiting while A holds staging")
        self.assertGreater(self.clock.now(), acquired_at)
        self.assertTrue(any("held by run 101" in line for line in self.logs), self.logs)

    def test_waiters_are_never_cancelled_to_make_room(self):
        # Unlike a concurrency group's single pending slot (#673), a third waiter doesn't
        # displace the second: both keep polling, and each gets the lock in turn.
        self.acquire(A)
        self.clock.on_sleep = lambda clock: clock.sleeps == 3 and lock.release(self.store, A, log=self.logs.append)
        self.acquire(B)
        C = run("303")
        self.clock.on_sleep = lambda clock: clock.sleeps == 6 and lock.release(self.store, B, log=self.logs.append)
        self.acquire(C)
        self.assertEqual(self.store.holder["run_id"], "303")

    def test_lock_of_a_completed_run_is_taken_over(self):
        self.acquire(A)
        self.finished.add("101")  # A was cancelled or crashed before its release job ran
        self.acquire(B)
        self.assertEqual(self.store.holder["run_id"], "202")
        self.assertEqual(self.clock.sleeps, 0)
        self.assertTrue(any("has completed" in line for line in self.logs), self.logs)

    def test_stale_lock_is_taken_over_when_github_cannot_say(self):
        self.acquire(A)
        self.clock.t += 5401
        self.acquire(B)
        self.assertEqual(self.store.holder["run_id"], "202")
        self.assertTrue(any("past the 90-minute limit" in line for line in self.logs), self.logs)

    def test_same_run_reacquires_its_own_lock(self):
        self.acquire(A)
        self.acquire(dict(A, run_attempt="2"))  # re-run of failed jobs keeps the run id
        self.assertEqual(self.store.holder["run_attempt"], "2")
        self.assertEqual(self.clock.sleeps, 0)

    def test_lost_create_race_reads_again_and_waits(self):
        self.store.lose_next_create = True
        self.store.racer_at = self.clock.now()
        self.clock.on_sleep = lambda clock: setattr(self.store, "generation", 0)  # racer releases
        self.acquire(B)
        self.assertEqual(self.store.holder["run_id"], "202")
        self.assertEqual(self.clock.sleeps, 1)

    def test_timeout_names_the_holder(self):
        self.acquire(A)
        with self.assertRaises(lock.LockTimeout) as ctx:
            self.acquire(B, timeout_s=60)
        self.assertIn("run 101", str(ctx.exception))
        self.assertIn("merge_group", str(ctx.exception))

    def test_release_leaves_another_runs_lock(self):
        self.acquire(A)
        self.assertFalse(lock.release(self.store, B, log=self.logs.append))
        self.assertEqual(self.store.holder["run_id"], "101")

    def test_release_of_a_free_lock_is_a_no_op(self):
        self.assertFalse(lock.release(self.store, B, log=self.logs.append))

    def test_github_is_asked_about_a_holder_at_most_every_two_minutes(self):
        self.acquire(A)
        asked = []

        def finished(run_id):
            asked.append(self.clock.now())
            return False

        self.clock.on_sleep = lambda clock: clock.sleeps == 40 and lock.release(self.store, A, log=self.logs.append)
        lock.acquire(
            self.store, B, finished, self.clock.now, self.clock.sleep,
            timeout_s=2700, stale_s=5400, poll_s=15, log=self.logs.append,
        )
        gaps = [later - earlier for earlier, later in zip(asked, asked[1:])]
        self.assertTrue(gaps, "expected repeated status checks over 40 polls")
        self.assertTrue(all(gap >= 120 for gap in gaps), gaps)


if __name__ == "__main__":
    unittest.main()
