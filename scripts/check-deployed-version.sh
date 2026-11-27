#!/usr/bin/env bash
# check-deployed-version.sh — Reports the deployed git commit (via GET /version) for the
# api and web Cloud Run services in staging and/or production, plus `git log -1` context
# for each returned SHA (#672 / #670).
#
# Closes the gap from the 2026-07-03 incident (#670): there was no fast way to check "what
# commit is actually running right now" without a Cloud Console detour. This curls the
# live /version endpoint on each service instead. api requires a Cloud Run identity token
# (mirrors the "Smoke test Cloud Run production — /readyz" step in
# .github/workflows/deploy.yml); web is --allow-unauthenticated.
#
# Attempts all 4 checks even if one fails — aggregates failures and reports a summary at
# the end, exiting non-zero only then (mirrors deploy.yml's "Validate production auth
# secrets (pre-promote)" step rather than aborting on the first failure).
#
# Three things worth knowing before reading the output:
#   * "environment" in the JSON response is DEPLOYMENT_ENVIRONMENT (staging / production),
#     which the deploy sets on each service (#1448). A service not deployed since then may
#     still report its old value; web's used to say "production" on staging. See
#     docs/runbooks/checking-deployed-version.md.
#   * On staging specifically, the reported SHA can lag the PR's actual head commit when a
#     run reused a prior image via staging.yml's skip-build optimization (see the "Resolve
#     image tag" step comment in staging.yml, #671) — this is expected, not a broken deploy.
#   * This reports what's live *right now*, which answers a different question than
#     deploy.yml's job-summary SHA (which reports what a specific run *deployed* at the
#     time it ran). The two can legitimately differ — see docs/runbooks/checking-deployed-version.md.
#
# Prereqs:
#   * gcloud CLI, authenticated, with roles/iam.serviceAccountTokenCreator on the relevant
#     CI/CD service account (needed only for the *-api checks — see --staging-service-account
#     / --prod-service-account below).
#   * git (for the `git log -1` context; degrades gracefully — not a crash — if a SHA isn't
#     resolvable in the local clone's history).
#   * node (JSON parsing — this repo's local dev convention avoids requiring jq; see CLAUDE.md).
#
# Usage:
#   bash scripts/check-deployed-version.sh [--env both|staging|production] \
#       [--staging-project-id <id>] [--prod-project-id <id>] \
#       [--staging-service-account <email>] [--prod-service-account <email>] \
#       [--region <region>]
#
# Examples:
#   bash scripts/check-deployed-version.sh                       # both environments
#   bash scripts/check-deployed-version.sh --env staging          # staging only

set -uo pipefail

ENVS="both"
STAGING_PROJECT_ID="lifting-logbook-staging"
PROD_PROJECT_ID="lifting-logbook-prod"
STAGING_SERVICE_ACCOUNT=""
PROD_SERVICE_ACCOUNT=""
REGION="us-central1"

usage() {
  echo "Usage: $0 [--env both|staging|production]" >&2
  echo "          [--staging-project-id <id>] [--prod-project-id <id>]" >&2
  echo "          [--staging-service-account <email>] [--prod-service-account <email>]" >&2
  echo "          [--region <region>]" >&2
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENVS="$2"; shift 2 ;;
    --staging-project-id) STAGING_PROJECT_ID="$2"; shift 2 ;;
    --prod-project-id) PROD_PROJECT_ID="$2"; shift 2 ;;
    --staging-service-account) STAGING_SERVICE_ACCOUNT="$2"; shift 2 ;;
    --prod-service-account) PROD_SERVICE_ACCOUNT="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

case "$ENVS" in
  both|staging|production) ;;
  *) echo "ERROR: --env must be both|staging|production (got '$ENVS')" >&2; exit 1 ;;
esac

command -v gcloud >/dev/null 2>&1 || { echo "ERROR: gcloud CLI not found on PATH." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found on PATH (needed for JSON parsing)." >&2; exit 1; }

FAILURES=0

# Parses a /version JSON body on stdin; prints "gitSha<TAB>environment" and returns 0, or
# returns 1 on invalid JSON / missing fields. Avoids a hard dependency on jq (not guaranteed
# installed locally — see CLAUDE.md), matching scripts/smoke-test-observability.sh's
# node-based JSON handling.
parse_version_json() {
  node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        if (typeof j.gitSha !== "string" || typeof j.environment !== "string") {
          process.exit(1);
        }
        process.stdout.write(j.gitSha + "\t" + j.environment);
      } catch (e) {
        process.exit(1);
      }
    });
  '
}

# Maps the --env label to the abbreviated infix Cloud Run service names actually use
# (lifting-logbook-stg-*, lifting-logbook-prod-* — see .github/workflows/deploy.yml's
# `gcloud run deploy` steps). Kept as a separate mapping from the "staging"/"production"
# labels used elsewhere in this script's flags/output, which read better for a human.
service_env_infix() {
  case "$1" in
    staging) echo "stg" ;;
    production) echo "prod" ;;
  esac
}

# Prints `git log -1` context for a SHA, or a clear degraded-not-crashed note if the SHA
# isn't resolvable in this local clone's history (e.g. a shallow clone, or truly unknown).
print_commit_context() {
  local sha="$1"
  if [ "$sha" = "unknown" ]; then
    echo "    (GIT_SHA was not baked into this image — cannot look up commit context)"
    return
  fi
  if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    git log -1 --format='    %h  %s  (%an, %ar)' "$sha"
  else
    echo "    (commit ${sha:0:7} not found in this local clone's history — try 'git fetch origin' or view it directly: https://github.com/merickvaughn/lifting-logbook/commit/${sha})"
  fi
}

# Fetches GET <url>/version in a single request (status and body must come from the same
# response — checking status via one request and parsing the body from a second, separate
# request leaves a window where a rolling deploy could swap revisions between the two calls
# and produce a status/body mismatch), validates the status, and parses the body.
# Prints "gitSha<TAB>environment" on success. On failure, prints a FAIL line (prefixed with
# the given label) to stderr and returns 1 — callers just need to check the return status.
#   $1 = label for FAIL messages (e.g. "staging web"), $2 = full URL (no trailing slash),
#   remaining args = extra curl options (e.g. -H "Authorization: ...")
fetch_version() {
  local label="$1" url="$2"; shift 2
  local response status body
  if ! response=$(curl -s -w '\n%{http_code}' --max-time 10 "$@" "${url}/version"); then
    echo "    FAIL: ${label} — curl could not reach ${url}/version" >&2
    return 1
  fi
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"

  if [ "$status" != "200" ]; then
    echo "    FAIL: ${label} — GET ${url}/version returned HTTP ${status} (expected 200)" >&2
    return 1
  fi

  local parsed
  if ! parsed=$(printf '%s' "$body" | parse_version_json); then
    echo "    FAIL: ${label} — /version returned malformed JSON: ${body}" >&2
    return 1
  fi

  printf '%s' "$parsed"
}

# Resolves a Cloud Run service's URL, checking the actual gcloud exit status (not just
# whether stdout came back empty — a denied/erroring gcloud call and a call that legitimately
# returns nothing are different failures, and conflating them produces a misleading message).
# Prints the URL (no trailing slash) on success; prints a FAIL line and returns 1 on failure.
#   $1 = label for FAIL messages, $2 = service name, $3 = GCP project id
resolve_service_url() {
  local label="$1" service="$2" project="$3"
  local url
  if ! url=$(gcloud run services describe "$service" --project="$project" --region="$REGION" --format='value(status.url)'); then
    echo "    FAIL: ${label} — could not resolve service URL for ${service} (gcloud exited non-zero — see error above)" >&2
    return 1
  fi
  if [ -z "$url" ]; then
    echo "    FAIL: ${label} — gcloud returned an empty URL for ${service} with no error (unexpected)" >&2
    return 1
  fi
  printf '%s' "${url%/}"
}

# Checks one service's /version and prints the standard report block. Shared by the
# --allow-unauthenticated (web) and identity-token (api) paths below — they differ only in
# whether curl_auth_args carries an Authorization header.
#   $1 = env label, $2 = service kind ("web"|"api"), $3 = service url,
#   remaining args = extra curl options for fetch_version (e.g. -H "Authorization: ...")
report_version() {
  local env="$1" kind="$2" url="$3"; shift 3
  local label="${env} ${kind}"

  local parsed
  if ! parsed=$(fetch_version "$label" "$url" "$@"); then
    FAILURES=$((FAILURES + 1))
    echo
    return
  fi

  local sha nodeenv
  IFS=$'\t' read -r sha nodeenv <<< "$parsed"

  echo "    url:         ${url}"
  echo "    gitSha:      ${sha}"
  echo "    environment: ${nodeenv}  (DEPLOYMENT_ENVIRONMENT, set by the deploy)"
  print_commit_context "$sha"
  echo
}

# Checks a --allow-unauthenticated web service. No identity token needed.
#   $1 = env label ("staging"|"production"), $2 = GCP project id
check_web() {
  local env="$1" project="$2"
  local service="lifting-logbook-$(service_env_infix "$env")-web"
  echo "==> ${env} web (${service})"

  local url
  if ! url=$(resolve_service_url "${env} web" "$service" "$project"); then
    FAILURES=$((FAILURES + 1))
    echo
    return
  fi

  report_version "$env" "web" "$url"
}

# Checks a --no-allow-unauthenticated api service. Mints a Cloud Run identity token via
# impersonation (same pattern as deploy.yml's prod /readyz smoke test) and never echoes,
# logs, or URL-embeds it — only ever passed via the Authorization header.
#   $1 = env label, $2 = GCP project id, $3 = service account email to impersonate
check_api() {
  local env="$1" project="$2" service_account="$3"
  local service="lifting-logbook-$(service_env_infix "$env")-api"
  echo "==> ${env} api (${service})"

  if [ -z "$service_account" ]; then
    echo "    FAIL: ${env} api — no service account provided (--${env}-service-account) — cannot mint a Cloud Run identity token" >&2
    FAILURES=$((FAILURES + 1))
    echo
    return
  fi

  local url
  if ! url=$(resolve_service_url "${env} api" "$service" "$project"); then
    FAILURES=$((FAILURES + 1))
    echo
    return
  fi

  local id_token
  if ! id_token=$(gcloud auth print-identity-token \
      --impersonate-service-account="$service_account" \
      --audiences="$url" --include-email); then
    echo "    FAIL: ${env} api — could not mint a Cloud Run identity token impersonating ${service_account} (gcloud exited non-zero — check you have roles/iam.serviceAccountTokenCreator on it)" >&2
    FAILURES=$((FAILURES + 1))
    echo
    return
  fi
  if [ -z "$id_token" ]; then
    echo "    FAIL: ${env} api — gcloud returned an empty identity token with no error (unexpected)" >&2
    FAILURES=$((FAILURES + 1))
    echo
    return
  fi

  report_version "$env" "api" "$url" -H "Authorization: Bearer ${id_token}"
  unset id_token
}

if [ "$ENVS" = "both" ] || [ "$ENVS" = "staging" ]; then
  check_web staging "$STAGING_PROJECT_ID"
  check_api staging "$STAGING_PROJECT_ID" "$STAGING_SERVICE_ACCOUNT"
fi

if [ "$ENVS" = "both" ] || [ "$ENVS" = "production" ]; then
  check_web production "$PROD_PROJECT_ID"
  check_api production "$PROD_PROJECT_ID" "$PROD_SERVICE_ACCOUNT"
fi

if [ "$FAILURES" -eq 0 ]; then
  echo "All checks passed."
  exit 0
else
  echo "FAILED: ${FAILURES} check(s) did not succeed — see above." >&2
  exit 1
fi
