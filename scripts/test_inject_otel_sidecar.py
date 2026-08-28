#!/usr/bin/env python3
"""Tests for scripts/inject-otel-sidecar.py (#786).

The injector rewrites the LIVE production Cloud Run api manifest at deploy time
(`gcloud run services describe --format=export` | inject | `gcloud run services replace`) —
a path that cannot be dry-run tested. These tests are the only automated gate on it: a
regression that mis-identifies the ingress container, drops a Terraform-managed field, or
re-runs non-idempotently would otherwise ship a broken production manifest unnoticed.

Design: stdlib ``unittest`` (no new dependency — PyYAML is already required by the injector
itself) and the script is run as a *subprocess* so the real CLI contract is exercised end to
end — stdout manifest, stderr guard messages, and exit codes, exactly as deploy.yml invokes
it (``python3 scripts/inject-otel-sidecar.py <path>`` with env vars).

Run locally:  ``python scripts/test_inject_otel_sidecar.py -v``   (needs ``pip install pyyaml``)
CI:           ``.github/workflows/ci.yml`` -> ``lint-and-test`` job.
"""
import os
import subprocess
import sys
import tempfile
import unittest

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "inject-otel-sidecar.py")
FIXTURE = os.path.join(HERE, "testdata", "cloud-run-api-export.yaml")

# Every env var the injector reads (required + optional). Stripped from the inherited
# environment before each run so a value set in the caller's shell cannot mask a test that
# deliberately omits one (e.g. the missing-required-var guard below).
INJECTOR_VARS = (
    "OTEL_CONFIG_SECRET", "OTEL_OTLP_ENDPOINT", "OTEL_LOKI_ENDPOINT",
    "OTEL_OTLP_SECRET", "OTEL_LOKI_SECRET", "COLLECTOR_IMAGE", "COLLECTOR_CPU",
    "COLLECTOR_MEMORY", "OTEL_TAIL_SAMPLE_RATE", "OTEL_DECISION_WAIT",
    "INGRESS_IMAGE", "INGRESS_CONTAINER_NAME", "INGRESS_EXTRA_ENV",
)

API_IMAGE = "us-central1-docker.pkg.dev/example-project/lifting-logbook/api:newsha1234567"

# The six required env vars, with representative (synthetic) values.
REQUIRED_ENV = {
    "INGRESS_IMAGE": API_IMAGE,
    "OTEL_CONFIG_SECRET": "lifting-logbook-prod-otel-collector-config",
    "OTEL_OTLP_ENDPOINT": "https://otlp-gateway.example.grafana.net/otlp",
    "OTEL_LOKI_ENDPOINT": "https://logs.example.grafana.net/otlp",
    "OTEL_OTLP_SECRET": "lifting-logbook-prod-otel-otlp-auth-header",
    "OTEL_LOKI_SECRET": "lifting-logbook-prod-otel-loki-auth-header",
}

# ── Web service (#804) ──────────────────────────────────────────────────────────────────────
# The web Cloud Run service reuses this same injector, differing only by INGRESS_CONTAINER_NAME=web
# and the image INGRESS_IMAGE points at.
WEB_FIXTURE = os.path.join(HERE, "testdata", "cloud-run-web-export.yaml")
WEB_IMAGE = "us-central1-docker.pkg.dev/example-project/lifting-logbook/web:newsha7654321"
WEB_ENV = dict(REQUIRED_ENV)
WEB_ENV["INGRESS_IMAGE"] = WEB_IMAGE
WEB_ENV["INGRESS_CONTAINER_NAME"] = "web"


def clean_env(**overrides):
    """The inherited environment minus every injector var, plus ``overrides``."""
    env = {k: v for k, v in os.environ.items() if k not in INJECTOR_VARS}
    env.update(overrides)
    return env


def run_injector(manifest_path=None, stdin_text=None, env=None):
    """Run the injector as a subprocess; return the CompletedProcess (text mode).

    ``manifest_path`` is passed as the argv path argument; when None the manifest is fed on
    stdin via ``stdin_text`` (the injector's other input mode). ``env`` defaults to a clean
    environment with all six required vars set.
    """
    if env is None:
        env = clean_env(**REQUIRED_ENV)
    args = [sys.executable, SCRIPT]
    if manifest_path is not None:
        args.append(manifest_path)
    return subprocess.run(
        args, input=stdin_text, env=env, capture_output=True, text=True,
    )


def containers_by_name(doc):
    return {c["name"]: c for c in doc["spec"]["template"]["spec"]["containers"]}


class InjectSuccessTest(unittest.TestCase):
    """A single-container export becomes a valid two-container manifest."""

    @classmethod
    def setUpClass(cls):
        proc = run_injector(FIXTURE)
        if proc.returncode != 0:
            raise AssertionError(f"injector exited {proc.returncode}: {proc.stderr}")
        cls.proc = proc
        cls.doc = yaml.safe_load(proc.stdout)
        cls.containers = containers_by_name(cls.doc)

    def test_exit_zero(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr)

    def test_two_containers_api_then_collector(self):
        names = [c["name"] for c in self.doc["spec"]["template"]["spec"]["containers"]]
        self.assertEqual(names, ["api", "otel-collector"])

    def test_api_image_replaced(self):
        self.assertEqual(self.containers["api"]["image"], API_IMAGE)

    def test_system_database_url_dropped(self):
        env_names = [e["name"] for e in self.containers["api"]["env"]]
        self.assertNotIn("SYSTEM_DATABASE_URL", env_names)

    def test_otel_endpoint_set_once_on_api(self):
        otel = [e for e in self.containers["api"]["env"]
                if e["name"] == "OTEL_EXPORTER_OTLP_ENDPOINT"]
        self.assertEqual(
            len(otel), 1,
            "OTEL_EXPORTER_OTLP_ENDPOINT must appear exactly once — the stale fixture value "
            "should be replaced, not duplicated",
        )
        self.assertEqual(otel[0]["value"], "http://localhost:4318")

    def test_ports_only_on_api_container(self):
        # Ingress-detection correctness: exactly the api container carries `ports`.
        self.assertIn("ports", self.containers["api"])
        self.assertNotIn("ports", self.containers["otel-collector"])

    def test_terraform_managed_base_config_preserved(self):
        # The injector must pass Terraform-owned base config through verbatim; dropping any of
        # it is one of the named regression classes in #786.
        spec = self.doc["spec"]["template"]["spec"]
        self.assertEqual(spec["containerConcurrency"], 80)
        self.assertTrue(spec["serviceAccountName"].startswith("lifting-logbook-prod-api-wi@"))
        tmpl_ann = self.doc["spec"]["template"]["metadata"]["annotations"]
        self.assertIn("run.googleapis.com/vpc-access-connector", tmpl_ann)
        api_env = {e["name"] for e in self.containers["api"]["env"]}
        self.assertIn("DATABASE_URL", api_env)   # unrelated secret env untouched
        self.assertIn("CLERK_SECRET_KEY", api_env)
        self.assertIn("NODE_ENV", api_env)

    def test_collector_and_config_volume_wired(self):
        col = self.containers["otel-collector"]
        col_env = {e["name"]: e for e in col["env"]}
        self.assertEqual(col_env["OTEL_COLLECTOR_OTLP_ENDPOINT"]["value"],
                         REQUIRED_ENV["OTEL_OTLP_ENDPOINT"])
        self.assertEqual(col_env["OTEL_COLLECTOR_LOKI_ENDPOINT"]["value"],
                         REQUIRED_ENV["OTEL_LOKI_ENDPOINT"])
        self.assertEqual(col_env["OTEL_COLLECTOR_OTLP_AUTH_HEADER"]["valueFrom"]["secretKeyRef"]["name"],
                         REQUIRED_ENV["OTEL_OTLP_SECRET"])
        vol_names = [v["name"] for v in self.doc["spec"]["template"]["spec"]["volumes"]]
        self.assertIn("otelconfig", vol_names)               # config-secret volume added
        self.assertIn("existing-unrelated-volume", vol_names)  # pre-existing volume preserved
        self.assertIn("otelconfig", [m["name"] for m in col["volumeMounts"]])

    def test_collector_config_file_wiring(self):
        # The collector's --config arg, its volume mountPath, and the mounted secret's file path
        # form ONE contract: --config must resolve to the mounted file. If a future injector edit
        # moved any one of the three independently, the sidecar would start but fail to load its
        # config and crash-loop in production — no telemetry, and the env/volume-name checks above
        # would still pass (the #768/#781 no-telemetry failure class this pipeline exists to catch).
        col = self.containers["otel-collector"]
        config_args = [a for a in col["args"] if a.startswith("--config=")]
        self.assertEqual(len(config_args), 1, "collector needs exactly one --config arg")
        config_path = config_args[0].split("=", 1)[1]
        mount = next(m for m in col["volumeMounts"] if m["name"] == "otelconfig")
        vol = next(v for v in self.doc["spec"]["template"]["spec"]["volumes"]
                   if v["name"] == "otelconfig")
        self.assertEqual(vol["secret"]["secretName"], REQUIRED_ENV["OTEL_CONFIG_SECRET"])
        item_path = vol["secret"]["items"][0]["path"]
        self.assertEqual(
            config_path, f"{mount['mountPath']}/{item_path}",
            "collector --config must resolve to the mounted secret file (mountPath/path)",
        )

    def test_collector_image_default_applied(self):
        # COLLECTOR_IMAGE is unset in the test env, so the injector's default must apply — exercises
        # the optional-env default path.
        self.assertEqual(self.containers["otel-collector"]["image"],
                         "otel/opentelemetry-collector-contrib:0.104.0")

    def test_server_assigned_fields_stripped(self):
        ann = self.doc["metadata"].get("annotations", {})
        self.assertNotIn("run.googleapis.com/urls", ann)
        self.assertNotIn("run.googleapis.com/ingress-status", ann)
        self.assertIn("run.googleapis.com/ingress", ann)   # real ingress config preserved
        tmpl_meta = self.doc["spec"]["template"]["metadata"]
        self.assertNotIn("name", tmpl_meta)   # cleared so Cloud Run assigns a fresh revision name
        self.assertNotIn("client.knative.dev/nonce", tmpl_meta.get("labels", {}))


class IdempotencyTest(unittest.TestCase):
    """Re-running on an already-injected two-container manifest reproduces it exactly."""

    def test_running_twice_equals_once(self):
        first = run_injector(FIXTURE)
        self.assertEqual(first.returncode, 0, first.stderr)
        with tempfile.TemporaryDirectory() as d:
            once_path = os.path.join(d, "once.yaml")
            with open(once_path, "w", encoding="utf-8") as f:
                f.write(first.stdout)
            second = run_injector(once_path)
        self.assertEqual(second.returncode, 0, second.stderr)
        # Compare parsed structures — robust to any incidental serialization differences.
        self.assertEqual(yaml.safe_load(first.stdout), yaml.safe_load(second.stdout))
        # And no stacked second collector: still exactly api + one otel-collector.
        names = [c["name"]
                 for c in yaml.safe_load(second.stdout)["spec"]["template"]["spec"]["containers"]]
        self.assertEqual(names, ["api", "otel-collector"])


class GuardTest(unittest.TestCase):
    """On malformed input or missing config the script must fail loudly, not emit a manifest."""

    def test_missing_spec_template_spec_exits_nonzero(self):
        proc = run_injector(stdin_text="metadata:\n  name: not-a-cloud-run-service\n")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "", "no manifest should be emitted on the error path")
        self.assertIn("spec.template.spec", proc.stderr)

    def test_no_ingress_ports_container_exits_nonzero(self):
        manifest = yaml.safe_dump({
            "spec": {"template": {"spec": {"containers": [
                {"name": "api", "image": "x", "env": []},  # no `ports` block anywhere
            ]}}},
        })
        proc = run_injector(stdin_text=manifest)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("ports", proc.stderr)

    def test_missing_ingress_image_exits_nonzero(self):
        # INGRESS_IMAGE unset → hard fail naming it, no manifest.
        env = clean_env(**{k: v for k, v in REQUIRED_ENV.items() if k != "INGRESS_IMAGE"})
        proc = run_injector(FIXTURE, env=env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "", "no manifest should be emitted on the error path")
        self.assertIn("INGRESS_IMAGE", proc.stderr)


class InjectWebServiceTest(unittest.TestCase):
    """The web export becomes a valid two-container manifest under INGRESS_CONTAINER_NAME=web.

    Mirrors InjectSuccessTest for the #804 web path: the ingress container is named ``web`` (not
    ``api``), the web image is applied, the OTEL endpoint is *added* (the web container has none
    to replace), and the Terraform-managed web env/secrets + serviceAccountName pass through.
    """

    @classmethod
    def setUpClass(cls):
        proc = run_injector(WEB_FIXTURE, env=clean_env(**WEB_ENV))
        if proc.returncode != 0:
            raise AssertionError(f"injector exited {proc.returncode}: {proc.stderr}")
        cls.proc = proc
        cls.doc = yaml.safe_load(proc.stdout)
        cls.containers = containers_by_name(cls.doc)

    def test_exit_zero(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr)

    def test_two_containers_web_then_collector(self):
        names = [c["name"] for c in self.doc["spec"]["template"]["spec"]["containers"]]
        self.assertEqual(names, ["web", "otel-collector"])

    def test_web_image_replaced(self):
        self.assertEqual(self.containers["web"]["image"], WEB_IMAGE)

    def test_otel_endpoint_added_once_on_web(self):
        # The web container has no pre-existing OTEL_EXPORTER_OTLP_ENDPOINT, so this proves it is
        # *added* exactly once — the sidecar wiring the #804 fix relies on.
        otel = [e for e in self.containers["web"]["env"]
                if e["name"] == "OTEL_EXPORTER_OTLP_ENDPOINT"]
        self.assertEqual(len(otel), 1)
        self.assertEqual(otel[0]["value"], "http://localhost:4318")

    def test_ports_only_on_web_container(self):
        self.assertIn("ports", self.containers["web"])
        self.assertNotIn("ports", self.containers["otel-collector"])

    def test_terraform_managed_web_config_preserved(self):
        spec = self.doc["spec"]["template"]["spec"]
        self.assertEqual(spec["containerConcurrency"], 80)
        self.assertTrue(spec["serviceAccountName"].startswith("lifting-logbook-prod-web-wi@"))
        web_env = {e["name"] for e in self.containers["web"]["env"]}
        # Runtime public-config (#396/ADR-028) + Clerk secret envs must survive the rewrite.
        self.assertIn("API_URL", web_env)
        self.assertIn("PUBLIC_API_URL", web_env)
        self.assertIn("CLERK_PUBLISHABLE_KEY", web_env)
        self.assertIn("CLERK_SECRET_KEY", web_env)
        self.assertIn("NODE_ENV", web_env)
        # The web container never carries SYSTEM_DATABASE_URL — the drop is a harmless no-op.
        self.assertNotIn("SYSTEM_DATABASE_URL", web_env)

    def test_collector_and_config_volume_added_from_scratch(self):
        # The web fixture has no pre-existing volumes, so the otelconfig volume is added fresh.
        col = self.containers["otel-collector"]
        vol_names = [v["name"] for v in self.doc["spec"]["template"]["spec"]["volumes"]]
        self.assertEqual(vol_names, ["otelconfig"])
        self.assertIn("otelconfig", [m["name"] for m in col["volumeMounts"]])
        col_env = {e["name"]: e for e in col["env"]}
        self.assertEqual(col_env["OTEL_COLLECTOR_OTLP_ENDPOINT"]["value"],
                         REQUIRED_ENV["OTEL_OTLP_ENDPOINT"])

    def test_server_assigned_fields_stripped(self):
        tmpl_meta = self.doc["spec"]["template"]["metadata"]
        self.assertNotIn("name", tmpl_meta)
        self.assertNotIn("client.knative.dev/nonce", tmpl_meta.get("labels", {}))


class IngressContainerNameResolutionTest(unittest.TestCase):
    """INGRESS_IMAGE is the sole image var; INGRESS_CONTAINER_NAME selects the container it lands on."""

    def test_empty_ingress_container_name_defaults_to_api(self):
        # An explicitly-empty INGRESS_CONTAINER_NAME must resolve to "api", not an empty
        # (invalid) container name — this locks the `or "api"` hardening, not a plain dict default.
        env = clean_env(**{**REQUIRED_ENV, "INGRESS_CONTAINER_NAME": ""})
        proc = run_injector(FIXTURE, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        names = [c["name"] for c in yaml.safe_load(proc.stdout)["spec"]["template"]["spec"]["containers"]]
        self.assertEqual(names, ["api", "otel-collector"])


class IngressExtraEnvTest(unittest.TestCase):
    """INGRESS_EXTRA_ENV merges KEY=VALUE pairs into the ingress env (#809 same-origin guard).

    The web deploy action derives the service's own public Cloud Run URL and passes
    CLIENT_ERROR_ALLOWED_ORIGINS + CLIENT_ERROR_DROP_CROSS_ORIGIN here, so the #806 guard
    classifies its own same-origin beacons correctly. These lock the merge/override/idempotency
    contract the deploy relies on.
    """

    # A representative pair: a synthetic Cloud Run URL allowlist + the observe-mode drop flag.
    GUARD_EXTRA_ENV = (
        "CLIENT_ERROR_ALLOWED_ORIGINS=https://lifting-logbook-stg-web-abc123.a.run.app\n"
        "CLIENT_ERROR_DROP_CROSS_ORIGIN=false"
    )

    def _run_web_with_extra(self, extra):
        env = clean_env(**{**WEB_ENV, "INGRESS_EXTRA_ENV": extra})
        proc = run_injector(WEB_FIXTURE, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return yaml.safe_load(proc.stdout)

    def test_guard_env_added_once_with_values(self):
        web_env = containers_by_name(self._run_web_with_extra(self.GUARD_EXTRA_ENV))["web"]["env"]
        allow = [e for e in web_env if e["name"] == "CLIENT_ERROR_ALLOWED_ORIGINS"]
        drop = [e for e in web_env if e["name"] == "CLIENT_ERROR_DROP_CROSS_ORIGIN"]
        self.assertEqual(len(allow), 1, "allowlist var must appear exactly once")
        self.assertEqual(allow[0]["value"], "https://lifting-logbook-stg-web-abc123.a.run.app")
        self.assertEqual(len(drop), 1, "drop flag must appear exactly once")
        self.assertEqual(drop[0]["value"], "false")

    def test_otel_and_terraform_env_untouched(self):
        web = containers_by_name(self._run_web_with_extra(self.GUARD_EXTRA_ENV))["web"]
        otel = [e for e in web["env"] if e["name"] == "OTEL_EXPORTER_OTLP_ENDPOINT"]
        self.assertEqual(len(otel), 1)
        self.assertEqual(otel[0]["value"], "http://localhost:4318")
        names = {e["name"] for e in web["env"]}
        self.assertIn("CLERK_SECRET_KEY", names)   # unrelated secret env preserved
        self.assertIn("PUBLIC_API_URL", names)

    def test_extra_env_overrides_existing_key(self):
        # An INGRESS_EXTRA_ENV key already present on the live service is replaced, not
        # duplicated — the strip-then-append contract that keeps a value change effective.
        web_env = containers_by_name(
            self._run_web_with_extra("PUBLIC_API_URL=https://override.example")
        )["web"]["env"]
        api = [e for e in web_env if e["name"] == "PUBLIC_API_URL"]
        self.assertEqual(len(api), 1)
        self.assertEqual(api[0]["value"], "https://override.example")

    def test_blank_lines_ignored(self):
        web_env = containers_by_name(
            self._run_web_with_extra("\n  \nCLIENT_ERROR_DROP_CROSS_ORIGIN=true\n\n")
        )["web"]["env"]
        drop = [e for e in web_env if e["name"] == "CLIENT_ERROR_DROP_CROSS_ORIGIN"]
        self.assertEqual(len(drop), 1)
        self.assertEqual(drop[0]["value"], "true")

    def test_malformed_extra_env_exits_nonzero(self):
        # A line with no '=' must fail the deploy loudly — no manifest emitted.
        env = clean_env(**{**WEB_ENV, "INGRESS_EXTRA_ENV": "NOEQUALS_HERE"})
        proc = run_injector(WEB_FIXTURE, env=env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "", "no manifest should be emitted on the error path")
        self.assertIn("INGRESS_EXTRA_ENV", proc.stderr)

    def test_idempotent_with_extra_env(self):
        # Re-running with the SAME extra env reproduces the manifest exactly (guard vars stripped
        # then re-appended, not stacked) — the property the re-run-safe deploy relies on.
        first = self._run_web_with_extra(self.GUARD_EXTRA_ENV)
        with tempfile.TemporaryDirectory() as d:
            once_path = os.path.join(d, "once.yaml")
            with open(once_path, "w", encoding="utf-8") as f:
                yaml.safe_dump(first, f)
            env = clean_env(**{**WEB_ENV, "INGRESS_EXTRA_ENV": self.GUARD_EXTRA_ENV})
            second = run_injector(once_path, env=env)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first, yaml.safe_load(second.stdout))


if __name__ == "__main__":
    unittest.main()
