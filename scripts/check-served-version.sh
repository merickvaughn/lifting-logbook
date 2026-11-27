#!/usr/bin/env bash
# check-served-version.sh — Fail unless a service's live GET /version reports the expected
# commit (#1042). A post-deploy smoke probe that proves WHICH build answered, not just that
# something did: /readyz, /livez and /sign-in all pass against any revision, so a pinned
# Cloud Run service kept serving a July build for three months while every probe stayed green.
#
# /version is @Public on the api (apps/api/src/health/health.controller.ts) and excluded from
# Clerk on web (apps/web/middleware.ts); both return {"gitSha": "<GIT_SHA build-arg>", ...}.
# The api additionally sits behind Cloud Run IAM, so pass a Cloud Run identity token as the
# third argument (as deploy.yml's prod /readyz smoke mints one).
#
# Only point it at a service nothing else deploys to concurrently, with a SHA the image was BUILT
# with: deploy.yml's production services (GIT_SHA=github.sha, serialized by the deploy-main group),
# and deploy.yml's staging services while deploy-staging holds the staging lock (#1052).
# Not staging.yml — its skip-build runs reuse an earlier image (#671), so GIT_SHA isn't the
# run's commit. There scripts/check-cloud-run-serving-revision.py (run by the deploy action) catches
# a pin, and scripts/check-staging-deployed-image.py checks the run's own images (#1208).
#
# Usage: bash scripts/check-served-version.sh <base-url> <expected-sha> [bearer-token]
# When CHECK_SERVED_VERSION_ENVIRONMENT is set, the answer that reports the expected commit must
# also report that `environment`, or the check fails at once (#1448). deploy.yml sets it to the
# same value for the web and api probes of one deployment, so the two services must agree.
# CHECK_SERVED_VERSION_ATTEMPTS (default 12) and CHECK_SERVED_VERSION_RETRY_DELAY (seconds,
# default 10) bound the wait to about 2 minutes. The delay setting exists for
# scripts/test_check_served_version.py.

set -uo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <base-url> <expected-sha> [bearer-token]" >&2
  exit 2
fi

BASE_URL="${1%/}"
EXPECTED="$2"
TOKEN="${3:-}"
EXPECTED_ENV="${CHECK_SERVED_VERSION_ENVIRONMENT:-}"
ATTEMPTS="${CHECK_SERVED_VERSION_ATTEMPTS:-12}"
DELAY="${CHECK_SERVED_VERSION_RETRY_DELAY:-10}"
AUTH=()
[ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")

# Cloud Run can keep routing requests to the previous revision after it reports 100% on the new
# one: on 2026-11-24 the old revision answered /readyz and /version 10 s after the service
# reported RoutesReady (#1473). So another commit's SHA is retried for the bounded window above,
# like an unreadable answer. A service pinned to an old revision (#1042) keeps answering with it
# for the whole window, and still fails.
SERVED=""
for i in $(seq 1 "$ATTEMPTS"); do
  # ${AUTH[@]+...}: an empty array under `set -u` is "unbound" on bash < 4.4.
  BODY=$(curl -s --max-time 10 ${AUTH[@]+"${AUTH[@]}"} "$BASE_URL/version" || true)
  SERVED=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('gitSha',''))" 2>/dev/null || true)
  if [ "$SERVED" = "$EXPECTED" ]; then
    echo "$BASE_URL/version reports gitSha=$SERVED, the commit this run deployed."
    if [ -n "$EXPECTED_ENV" ]; then
      SERVED_ENV=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('environment',''))" 2>/dev/null || true)
      if [ "$SERVED_ENV" != "$EXPECTED_ENV" ]; then
        echo "::error title=Served environment mismatch::$BASE_URL/version reports environment='${SERVED_ENV:-<none>}', expected $EXPECTED_ENV. Check the service's DEPLOYMENT_ENVIRONMENT (#1448)."
        exit 1
      fi
      echo "$BASE_URL/version reports environment=$SERVED_ENV."
    fi
    exit 0
  fi
  [ "$i" -lt "$ATTEMPTS" ] || break
  echo "/version attempt $i of $ATTEMPTS: gitSha='${SERVED:-<none>}', expected $EXPECTED; retrying in ${DELAY}s..."
  sleep "$DELAY"
done

echo "::error title=Served build mismatch::$BASE_URL/version reports gitSha='${SERVED:-<none>}', expected $EXPECTED, after $ATTEMPTS attempts ${DELAY}s apart. The URL is not answering from the revision this run deployed; check status.traffic (docs/runbooks/deploy-regression-rollback.md)."
exit 1
