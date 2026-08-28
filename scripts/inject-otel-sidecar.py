#!/usr/bin/env python3
"""Inject the OTel Collector sidecar into an exported Cloud Run service manifest (#768, #804).

Reads a `gcloud run services describe --format=export` manifest and rewrites it into a
two-container manifest (the ingress app container + `otel-collector`) for
`gcloud run services replace`. Serves both the api service (#768) and the web service
(#804); the ingress container name is parameterized (INGRESS_CONTAINER_NAME, default "api").

Why derive from the live service instead of a static template: the Cloud Run service's
base spec (VPC connector, scaling, service account, concurrency, startup probe, existing
env/secrets) is created by Terraform, but the running revision is
`lifecycle.ignore_changes = [template]` and is mutated only by the deploy pipeline. Deriving
the manifest from `describe --format=export` preserves every one of those managed fields
verbatim, so the ONLY changes this makes are:
  * name the ingress container (INGRESS_CONTAINER_NAME, default `api`) and set its image,
  * add `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to the ingress container,
  * drop the unused owner-cred `SYSTEM_DATABASE_URL` secret env if present (#534; api only),
  * add (or rebuild) the `otel-collector` sidecar and its config-file volume.
That makes it safe for the production service, which cannot be dry-run tested, and idempotent:
re-running on an already-two-container manifest rebuilds the sidecar cleanly rather than
stacking a second one.

The `--container` form of `gcloud run deploy` was rejected: on this gcloud version it hits an
unresolvable port catch-22 for a single→multi container transition (omit `--port` on the
sidecar and the collector image's EXPOSE infers one → "exactly one container with an exposed
port"; add `--port=default` and it counts as specifying a port → "exactly one must specify
--port"). `services replace` gives explicit, unambiguous control: only the ingress container
carries a `ports:` block. See #768.

Usage:
  gcloud run services describe <svc> --region <r> --project <p> --format=export \\
    | INGRESS_IMAGE=... OTEL_CONFIG_SECRET=... OTEL_OTLP_ENDPOINT=... OTEL_LOKI_ENDPOINT=... \\
      OTEL_OTLP_SECRET=... OTEL_LOKI_SECRET=... python3 scripts/inject-otel-sidecar.py \\
    > rendered.yaml

Required env vars:
  INGRESS_IMAGE        full ingress-app image ref (registry/<api|web>:<sha>)
  OTEL_CONFIG_SECRET   Secret Manager secret holding config.yaml (mounted as a file)
  OTEL_OTLP_ENDPOINT   Grafana Cloud OTLP gateway base URL (traces + metrics)
  OTEL_LOKI_ENDPOINT   Grafana Cloud Loki OTLP base URL (logs)
                       (both from the single source infra/observability/grafana-endpoints.env,
                       #785 — the deploy step sources it; do not hardcode here)
  OTEL_OTLP_SECRET     Secret Manager secret for the OTLP auth header
  OTEL_LOKI_SECRET     Secret Manager secret for the Loki auth header
Optional env vars:
  INGRESS_CONTAINER_NAME ('api')   name for the ingress container — set to 'web' for the web
                       service (#804). Cosmetic in Cloud Run, but keeps per-container logs and
                       metrics correctly labelled.
  COLLECTOR_IMAGE (otel/opentelemetry-collector-contrib:0.104.0)   # script default (local/manual);
                       # the deploy step (deploy.yml) sets it to the Artifact Registry Docker Hub
                       # pull-through mirror pinned by digest — infra/observability/otel-collector-image.env (#795)
  COLLECTOR_CPU ('1')   COLLECTOR_MEMORY ('256Mi')                 # script defaults
  OTEL_TAIL_SAMPLE_RATE ('20')   OTEL_DECISION_WAIT ('10s')        # mirror infra/kubernetes/values/*-otel-collector.yaml
  INGRESS_EXTRA_ENV (unset)   newline-separated KEY=VALUE pairs merged into (overriding) the
                       ingress container's env. Used by the web deploy for the #806/#809
                       same-origin guard: CLIENT_ERROR_ALLOWED_ORIGINS (the web service's own
                       public URL) + CLIENT_ERROR_DROP_CROSS_ORIGIN. Unset for the api service.

Reads the manifest from a path argument if given, else stdin. Writes YAML to stdout.
"""
import os
import sys

try:
    import yaml
except ImportError:
    sys.exit("inject-otel-sidecar: PyYAML is required (pip install pyyaml)")


def req(name):
    value = os.environ.get(name)
    if not value:
        sys.exit(f"inject-otel-sidecar: missing required env var {name}")
    return value


def parse_extra_env(raw):
    """Parse newline-separated ``KEY=VALUE`` pairs into an ordered ``[{name, value}]`` list.

    Blank lines are skipped; only the first ``=`` splits (so a value may itself contain ``=``).
    A non-blank line with no ``=`` or an empty key is a hard error — a malformed INGRESS_EXTRA_ENV
    must fail the deploy loudly rather than silently drop guard config onto the live service.
    """
    pairs = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if "=" not in line:
            sys.exit(f"inject-otel-sidecar: INGRESS_EXTRA_ENV entry missing '=': {line!r}")
        name, value = line.split("=", 1)
        if not name.strip():
            sys.exit(f"inject-otel-sidecar: INGRESS_EXTRA_ENV entry has empty key: {line!r}")
        pairs.append({"name": name.strip(), "value": value})
    return pairs


def main():
    # The general name for the ingress-app image, whichever service is being deployed (api or web).
    ingress_image = req("INGRESS_IMAGE")
    # `or "api"` (not a plain default) so an explicitly-empty INGRESS_CONTAINER_NAME still
    # resolves to "api" rather than producing an invalid empty container name in the manifest.
    ingress_name = os.environ.get("INGRESS_CONTAINER_NAME") or "api"
    config_secret = req("OTEL_CONFIG_SECRET")
    otlp_endpoint = req("OTEL_OTLP_ENDPOINT")
    loki_endpoint = req("OTEL_LOKI_ENDPOINT")
    otlp_secret = req("OTEL_OTLP_SECRET")
    loki_secret = req("OTEL_LOKI_SECRET")
    collector_image = os.environ.get("COLLECTOR_IMAGE", "otel/opentelemetry-collector-contrib:0.104.0")
    collector_cpu = os.environ.get("COLLECTOR_CPU", "1")
    collector_memory = os.environ.get("COLLECTOR_MEMORY", "256Mi")
    sample_rate = os.environ.get("OTEL_TAIL_SAMPLE_RATE", "20")
    decision_wait = os.environ.get("OTEL_DECISION_WAIT", "10s")
    # Optional extra ingress env (KEY=VALUE per line), merged into — and overriding — the live
    # ingress env below. The web deploy uses it for the #806/#809 same-origin guard; unset for api.
    extra_ingress_env = parse_extra_env(os.environ.get("INGRESS_EXTRA_ENV"))

    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    text = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    doc = yaml.safe_load(text)

    try:
        spec = doc["spec"]["template"]["spec"]
    except (KeyError, TypeError):
        sys.exit("inject-otel-sidecar: manifest has no spec.template.spec (not a Cloud Run service export?)")
    containers = spec.get("containers") or []

    # The ingress container is the one carrying a `ports:` block — exactly one in a valid
    # Cloud Run service. Identifying it by ports (not by index/name) survives both the first
    # single-container run and idempotent re-runs on a 2-container manifest, for either the api
    # or the web service.
    ingress = next((c for c in containers if c.get("ports")), None)
    if ingress is None:
        sys.exit("inject-otel-sidecar: no container with a `ports` section found (cannot identify the ingress container)")
    ingress["name"] = ingress_name
    ingress["image"] = ingress_image

    # ingress env: ensure OTEL_EXPORTER_OTLP_ENDPOINT points at the sidecar; drop the unused
    # owner-cred SYSTEM_DATABASE_URL (#534; present on api, absent on web — a no-op there); apply
    # any INGRESS_EXTRA_ENV overrides (the #806/#809 same-origin guard on web). Strip each managed
    # or overridden name first, then re-append, so re-runs are idempotent and a changed value wins.
    # Preserve every other env/secret verbatim.
    managed_names = {"SYSTEM_DATABASE_URL", "OTEL_EXPORTER_OTLP_ENDPOINT"} | {e["name"] for e in extra_ingress_env}
    ingress_env = [e for e in (ingress.get("env") or []) if e.get("name") not in managed_names]
    ingress_env.append({"name": "OTEL_EXPORTER_OTLP_ENDPOINT", "value": "http://localhost:4318"})
    ingress_env.extend(extra_ingress_env)
    ingress["env"] = ingress_env

    collector = {
        "name": "otel-collector",
        "image": collector_image,
        "args": ["--config=/etc/otelcol/config.yaml"],
        "env": [
            {"name": "OTEL_COLLECTOR_OTLP_ENDPOINT", "value": otlp_endpoint},
            {"name": "OTEL_COLLECTOR_LOKI_ENDPOINT", "value": loki_endpoint},
            {"name": "OTEL_TAIL_SAMPLE_RATE", "value": sample_rate},
            {"name": "OTEL_DECISION_WAIT", "value": decision_wait},
            {"name": "OTEL_COLLECTOR_OTLP_AUTH_HEADER",
             "valueFrom": {"secretKeyRef": {"name": otlp_secret, "key": "latest"}}},
            {"name": "OTEL_COLLECTOR_LOKI_AUTH_HEADER",
             "valueFrom": {"secretKeyRef": {"name": loki_secret, "key": "latest"}}},
        ],
        "resources": {"limits": {"cpu": collector_cpu, "memory": collector_memory}},
        "volumeMounts": [{"name": "otelconfig", "mountPath": "/etc/otelcol"}],
    }
    # ingress first, then a fresh collector — dropping any prior collector makes re-runs idempotent.
    spec["containers"] = [ingress, collector]

    # Cloud Run mounts config *files* from Secret Manager (no ConfigMap volume type). Mount the
    # config secret's :latest version as the file config.yaml under /etc/otelcol.
    volumes = [v for v in (spec.get("volumes") or []) if v.get("name") != "otelconfig"]
    volumes.append({
        "name": "otelconfig",
        "secret": {"secretName": config_secret, "items": [{"key": "latest", "path": "config.yaml"}]},
    })
    spec["volumes"] = volumes

    # Strip status-ish / server-assigned fields that can make `services replace` reject the doc.
    metadata_annotations = (doc.get("metadata") or {}).get("annotations") or {}
    for key in ("run.googleapis.com/urls", "run.googleapis.com/ingress-status"):
        metadata_annotations.pop(key, None)
    template_metadata = doc["spec"]["template"].get("metadata") or {}
    template_metadata.pop("name", None)  # let Cloud Run assign the new revision name
    labels = template_metadata.get("labels") or {}
    labels.pop("client.knative.dev/nonce", None)  # let Cloud Run assign a fresh nonce

    yaml.safe_dump(doc, sys.stdout, default_flow_style=False, sort_keys=False)


if __name__ == "__main__":
    main()
