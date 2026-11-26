#!/usr/bin/env python3
"""Tests for scripts/check-served-version.sh (#1042).

The script is a production deploy gate: deploy.yml's prod smoke steps fail unless GET /version
reports the commit the run deployed. These tests serve canned /version responses from a local
``http.server`` and run the real script against it as a subprocess, covering the branches the
gate depends on:
  * match -> exit 0;
  * the previous build answering for a few attempts, then this one -> exit 0 (#1473: Cloud Run
    routed to the old revision 10 s after reporting 100% on the new one);
  * a mismatch that persists for every attempt (a pinned service, #1042) -> exit 1 naming the
    served SHA, after exactly CHECK_SERVED_VERSION_ATTEMPTS requests;
  * an unreadable answer (non-JSON, no gitSha) -> retried, then exit 1 naming no served SHA;
  * the bearer token, when given, is sent as an Authorization header, and none is sent otherwise
    (the empty-array expansion under `set -u`);
  * a trailing slash on the base URL is stripped;
  * missing arguments -> exit 2 (usage).

CHECK_SERVED_VERSION_RETRY_DELAY=0 keeps the retry case fast. Needs bash, curl and python3 on PATH,
as the deploy runner has.

Run locally:  ``python scripts/test_check_served_version.py -v``   (no dependencies)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import http.server
import os
import shutil
import subprocess
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "check-served-version.sh")
SHA = "92a8462616d0ce9010c5dc6165f26392812dc79b"
OTHER = "0000000000000000000000000000000000000000"


class VersionServer:
    """A localhost /version endpoint; records each request's path and auth.

    ``body`` is a fixed response, or a list answered in order with its last entry repeated."""

    def __init__(self, body):
        requests = self.requests = []
        bodies = body if isinstance(body, list) else [body]

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("Authorization")))
                data = bodies[min(len(requests), len(bodies)) - 1].encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def run_script(*args, attempts=None):
    env = dict(os.environ, CHECK_SERVED_VERSION_RETRY_DELAY="0")
    env.pop("CHECK_SERVED_VERSION_ATTEMPTS", None)
    if attempts is not None:
        env["CHECK_SERVED_VERSION_ATTEMPTS"] = attempts
    return subprocess.run(
        [shutil.which("bash") or "bash", SCRIPT, *args],
        capture_output=True, text=True, env=env, timeout=120,
    )


class CheckServedVersionTest(unittest.TestCase):
    def serve(self, body):
        server = VersionServer(body)
        self.addCleanup(server.close)
        return server

    def test_matching_sha_passes(self):
        server = self.serve(f'{{"gitSha":"{SHA}","environment":"production"}}')
        proc = run_script(server.url, SHA)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn(f"gitSha={SHA}", proc.stdout)
        self.assertEqual([p for p, _ in server.requests], ["/version"])

    def test_previous_build_then_this_one_passes(self):
        # The #1473 shape: the old revision keeps answering briefly after the traffic switch.
        server = self.serve([f'{{"gitSha":"{OTHER}"}}'] * 3 + [f'{{"gitSha":"{SHA}"}}'])
        proc = run_script(server.url, SHA)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn(f"attempt 1 of 12: gitSha='{OTHER}', expected {SHA}", proc.stdout)
        self.assertEqual(len(server.requests), 4)

    def test_persistent_mismatch_fails_after_all_attempts(self):
        # The #1042 shape: a pinned service answers with the old build for the whole window.
        server = self.serve(f'{{"gitSha":"{OTHER}"}}')
        proc = run_script(server.url, SHA)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn(f"reports gitSha='{OTHER}', expected {SHA}, after 12 attempts", proc.stdout)
        self.assertEqual(len(server.requests), 12, "the default window is 12 attempts")

    def test_attempts_setting_bounds_the_window(self):
        server = self.serve(f'{{"gitSha":"{OTHER}"}}')
        proc = run_script(server.url, SHA, attempts="3")
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(len(server.requests), 3)

    def test_unreadable_answer_is_retried_then_fails(self):
        server = self.serve("<html>403 Forbidden</html>")
        proc = run_script(server.url, SHA)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("reports gitSha='<none>'", proc.stdout)
        self.assertEqual(len(server.requests), 12, "an unreadable answer is retried 12 times")

    def test_missing_git_sha_field_is_retried_then_fails(self):
        server = self.serve('{"environment":"production"}')
        proc = run_script(server.url, SHA)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertEqual(len(server.requests), 12)

    def test_bearer_token_sent_when_given(self):
        server = self.serve(f'{{"gitSha":"{SHA}"}}')
        proc = run_script(server.url, SHA, "test-token")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(server.requests[0][1], "Bearer test-token")
        self.assertNotIn("test-token", proc.stdout + proc.stderr, "the token must never be printed")

    def test_no_auth_header_without_token(self):
        server = self.serve(f'{{"gitSha":"{SHA}"}}')
        proc = run_script(server.url, SHA)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIsNone(server.requests[0][1])

    def test_trailing_slash_stripped(self):
        server = self.serve(f'{{"gitSha":"{SHA}"}}')
        proc = run_script(server.url + "/", SHA)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(server.requests[0][0], "/version")

    def test_missing_arguments_is_usage_error(self):
        proc = run_script("http://127.0.0.1:9")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("Usage:", proc.stderr)


if __name__ == "__main__":
    unittest.main()
