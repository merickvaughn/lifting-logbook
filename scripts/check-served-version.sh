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
# with: deploy.yml's production services (GIT_SHA=github.sha, serialized by the deploy-main group).
# Not staging — staging.yml redeploys it for every PR push with no lock against deploy.yml, and its
# skip-build runs reuse an earlier image (#671) — where scripts/check-cloud-run-serving-revision.py
# (run by the deploy action) catches a pin instead.
#
# Usage: bash scripts/check-served-version.sh <base-url> <expected-sha> [bearer-token]
# CHECK_SERVED_VERSION_RETRY_DELAY (seconds, default 10) exists for scripts/test_check_served_version.py.

set -uo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <base-url> <expected-sha> [bearer-token]" >&2
  exit 2
fi

BASE_URL="${1%/}"
EXPECTED="$2"
TOKEN="${3:-}"
DELAY="${CHECK_SERVED_VERSION_RETRY_DELAY:-10}"
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
  echo "/version attempt $i: no gitSha in the response, retrying in ${DELAY}s..."
  sleep "$DELAY"
done

echo "::error title=Served build mismatch::$BASE_URL/version reports gitSha='${SERVED:-<none>}', expected $EXPECTED. The URL is not answering from the revision this run deployed; check status.traffic (docs/runbooks/deploy-regression-rollback.md)."
exit 1
