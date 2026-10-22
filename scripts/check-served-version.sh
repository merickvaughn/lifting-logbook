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
# Only compare against a SHA the image was BUILT with. deploy.yml builds every image with
# GIT_SHA=${{ github.sha }}; staging.yml's skip-build runs reuse an earlier image (#671), so
# PR staging is checked by scripts/check-cloud-run-serving-revision.py instead.
#
# Usage: bash scripts/check-served-version.sh <base-url> <expected-sha> [bearer-token]

set -uo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <base-url> <expected-sha> [bearer-token]" >&2
  exit 2
fi

BASE_URL="${1%/}"
EXPECTED="$2"
TOKEN="${3:-}"
AUTH=()
[ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")

# The new revision already serves 100% once `services replace` returns, so this rarely needs a
# second attempt; the retry only absorbs a transient non-200 right after the traffic switch.
SERVED=""
for i in $(seq 1 6); do
  # ${AUTH[@]+...}: an empty array under `set -u` is "unbound" on bash < 4.4.
  BODY=$(curl -s --max-time 10 ${AUTH[@]+"${AUTH[@]}"} "$BASE_URL/version" || true)
  SERVED=$(printf '%s' "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('gitSha',''))" 2>/dev/null || true)
  if [ "$SERVED" = "$EXPECTED" ]; then
    echo "$BASE_URL/version reports gitSha=$SERVED, the commit this run deployed."
    exit 0
  fi
  if [ -n "$SERVED" ]; then
    # A parseable answer naming another commit is the failure this probe exists for; retrying
    # would only delay it.
    break
  fi
  echo "/version attempt $i: no gitSha in the response, retrying in 10s..."
  sleep 10
done

echo "::error title=Served build mismatch::$BASE_URL/version reports gitSha='${SERVED:-<none>}', expected $EXPECTED. The URL is not answering from the revision this run deployed; check status.traffic (docs/runbooks/deploy-regression-rollback.md)."
exit 1
