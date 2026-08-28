#!/usr/bin/env bash
# tempo-query.sh — run READ-ONLY TraceQL / trace queries against Grafana Cloud Tempo.
#
# Purpose:   Lets Claude Code (or an operator) validate span tags autonomously —
#            e.g. confirm #809's `client.origin.check` span tag only ever takes
#            `same-origin` in staging — without hand-running TraceQL in the Grafana
#            Explore UI. Mirrors run-calibration-queries.sh. Tracked in #829.
#
# READ-ONLY: every subcommand issues nothing but HTTP GET against Tempo's read API.
#            Pair it with a `traces:read`-scoped Access Policy token (see
#            .tempo-credentials.example) — no write/ingest scope is needed or used.
#
# Prereqs:   bash, curl, node. Credentials via tempo-query-env.sh (this script sources
#            it; see .tempo-credentials.example). The token must be `traces:read`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<'EOF'
tempo-query.sh — read-only TraceQL / trace queries against Grafana Cloud Tempo (#829).

Every subcommand issues only HTTP GET; use a `traces:read`-scoped token.

Usage: scripts/observability/tempo-query.sh <subcommand> [args]

  search '<traceql>'   TraceQL search. Example:
                         search '{ span.client.origin.check = "same-origin" }'
                       Range defaults to the last hour; override with TEMPO_LOOKBACK
                       (seconds) or explicit TEMPO_START / TEMPO_END (unix seconds).
                       TEMPO_LIMIT caps returned traces (default 20).
  trace <traceID>      Fetch one trace by its 32-hex ID (span count + services).
  tags                 List searchable tag names (doubles as a credentials smoke test).
  tag-values <tag>     List observed values for one (unscoped) tag. Example:
                         tag-values client.origin.check

Target: staging by default. One Grafana Cloud stack serves BOTH environments, so these
  credentials already read production traces and TEMPO_TARGET=prod falls back to the
  staging set when no TEMPO_PROD_* is configured. Scope queries to the environment:
    search '{ resource.deployment.environment.name = "production" }'
Credentials: run `source scripts/observability/tempo-setup.sh` once to persist them to
  ~/.bashrc (outside every worktree, so they resolve everywhere). Or use a gitignored
  scripts/observability/.tempo-credentials (see .tempo-credentials.example) — from a
  worktree, the canonical checkout's copy is used when there is no local one.
EOF
}

SUBCMD="${1:-}"
case "$SUBCMD" in
  ''|-h|--help)
    usage
    [ -z "$SUBCMD" ] && exit 1 || exit 0 ;;
esac
shift

# Load + validate credentials (exports TEMPO_ADDRESS / TEMPO_API_USER / TEMPO_API_KEY).
# shellcheck source=scripts/observability/tempo-query-env.sh
if ! source "$SCRIPT_DIR/tempo-query-env.sh"; then
  exit 1
fi

for bin in curl node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH." >&2; exit 1; }
done

BASE="${TEMPO_ADDRESS%/}"

# curl wrapper — GET only, basic auth, optional self-hosted tenant header.
tempo_get() {
  local path="$1"; shift
  # Bounded timeouts so a hung / black-holed Tempo host can't block an autonomous caller
  # forever. TEMPO_MAX_TIME overrides the total cap for a genuinely slow search.
  local curl_args=(-sS -G --connect-timeout 10 --max-time "${TEMPO_MAX_TIME:-60}")
  [ -n "${TEMPO_TENANT_ID:-}" ] && curl_args+=(-H "X-Scope-OrgID: $TEMPO_TENANT_ID")
  # Pass the traces:read token out-of-band via a --config read from stdin, so the
  # credential never lands in the process argument list (ps / /proc/<pid>/cmdline).
  printf 'user = "%s:%s"\n' "$TEMPO_API_USER" "$TEMPO_API_KEY" \
    | curl "${curl_args[@]}" -K - "$BASE$path" "$@"
}

format() { node "$SCRIPT_DIR/format-tempo-result.js" "$1"; }

case "$SUBCMD" in
  search)
    QUERY="${1:-}"
    if [ -z "$QUERY" ]; then
      echo "ERROR: search needs a TraceQL query, e.g.:" >&2
      echo "  $0 search '{ span.client.origin.check = \"same-origin\" }'" >&2
      exit 1
    fi
    # Validate the numeric overrides up front — an unquoted non-integer (e.g.
    # TEMPO_LOOKBACK=1h) would otherwise abort the arithmetic below with a cryptic
    # `set -u` "unbound variable" error instead of a clear message.
    for _v in TEMPO_START TEMPO_END TEMPO_LOOKBACK TEMPO_LIMIT; do
      _val="${!_v:-}"
      if [ -n "$_val" ] && ! [[ "$_val" =~ ^[0-9]+$ ]]; then
        echo "ERROR: $_v must be a non-negative integer (got '$_val')." >&2
        exit 1
      fi
    done
    END="${TEMPO_END:-$(date +%s)}"
    START="${TEMPO_START:-$(( END - ${TEMPO_LOOKBACK:-3600} ))}"
    LIMIT="${TEMPO_LIMIT:-20}"
    echo "Tempo search @ $BASE/api/search  (start=$START end=$END limit=$LIMIT)"
    echo "  q=$QUERY"
    tempo_get "/api/search" \
      --data-urlencode "q=$QUERY" \
      --data-urlencode "start=$START" \
      --data-urlencode "end=$END" \
      --data-urlencode "limit=$LIMIT" | format search
    ;;
  trace)
    TID="${1:-}"
    [ -n "$TID" ] || { echo "ERROR: trace needs a traceID." >&2; exit 1; }
    echo "Tempo trace @ $BASE/api/traces/$TID"
    tempo_get "/api/traces/$TID" | format trace
    ;;
  tags)
    echo "Tempo tags @ $BASE/api/search/tags"
    tempo_get "/api/search/tags" | format tags
    ;;
  tag-values)
    TAG="${1:-}"
    [ -n "$TAG" ] || { echo "ERROR: tag-values needs a tag name, e.g. client.origin.check" >&2; exit 1; }
    echo "Tempo tag-values @ $BASE/api/search/tag/$TAG/values"
    tempo_get "/api/search/tag/$TAG/values" | format tag-values
    ;;
  *)
    echo "ERROR: unknown subcommand '$SUBCMD'. Run '$0 --help'." >&2
    exit 1
    ;;
esac
