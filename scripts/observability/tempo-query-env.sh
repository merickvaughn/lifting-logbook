#!/usr/bin/env bash
# tempo-query-env.sh — load and export Grafana Cloud Tempo *read* query credentials.
#
# Purpose:   Exports TEMPO_ADDRESS / TEMPO_API_USER / TEMPO_API_KEY (and optional
#            TEMPO_TENANT_ID) into the CURRENT shell so tempo-query.sh can run
#            read-only TraceQL queries against staging (or prod) Grafana Cloud Tempo.
#            This lets span-tag validations — e.g. #809's `client.origin.check`
#            same-origin guard — run autonomously instead of a human hand-running
#            TraceQL in Grafana Explore. Mirrors mimir-query-env.sh. Tracked in #829.
#
# Usage:     source scripts/observability/tempo-query-env.sh              # staging (default)
#            TEMPO_TARGET=prod source scripts/observability/tempo-query-env.sh
#            It MUST be sourced (not executed) or the exports do not survive.
#
# Target:    TEMPO_TARGET selects which credential set to export: `staging` (default)
#            or `prod`. The credentials file provides TEMPO_<TARGET>_* variables; this
#            script maps the selected set onto the canonical TEMPO_* names above.
#
#            ONE STACK SERVES BOTH ENVIRONMENTS. Staging and production push to the same
#            Grafana Cloud stack (a single OTLP instance), so the staging read credentials
#            already read production traces and `deployment.environment.name` is the only
#            discriminator between them. `TEMPO_TARGET=prod` therefore falls back to the
#            staging credential set when no separate TEMPO_PROD_* is configured, printing
#            a notice and the environment filter to use. Filling in a TEMPO_PROD_* block
#            takes precedence over the fallback, so a genuinely separate prod stack — if
#            one is ever provisioned — needs no code change here (#949).
#
# Credentials, in the order this script looks for them:
#            1. Environment variables already exported — the recommended home. Run
#               `source scripts/observability/tempo-setup.sh` once to persist them to
#               ~/.bashrc, which lives outside every checkout and worktree, so they
#               resolve from ANY worktree and no cleanup routine can delete them.
#            2. `<this script's dir>/.tempo-credentials` (gitignored) — copy
#               `.tempo-credentials.example` and fill in the values.
#            3. The same path in the repo's CANONICAL checkout. A linked git worktree has
#               its own scripts/observability/, so without this a credentials file placed
#               in the canonical checkout would be invisible from every worktree (#949).
#            The token must be scoped `traces:read` (read-only). Note the OTLP push tokens
#            in GCP Secret Manager are write-only and cannot be reused for reads.
#            Escape hatch: if TEMPO_ADDRESS / TEMPO_API_USER / TEMPO_API_KEY are already
#            all set in the environment, they are used as-is and the target mapping is
#            skipped (export them by hand and skip the file).
#
# Prereqs:   none (pure bash; the canonical-checkout lookup uses `git` when available).
#            The runner tempo-query.sh needs curl + node.

# Refuse to run if executed rather than sourced (exports would be thrown away).
if ! (return 0 2>/dev/null); then
  echo "ERROR: this script must be sourced, not executed:" >&2
  echo "  source scripts/observability/tempo-query-env.sh" >&2
  exit 1
fi

_tqe_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_tqe_creds="$_tqe_dir/.tempo-credentials"
_tqe_creds_src=""

# Prune-safe fallback (#949). A linked worktree carries its own copy of this directory, so
# a credentials file living in the canonical checkout is invisible from inside one — which
# is how the only read credential on a machine ended up stranded in a disposable worktree
# that routine housekeeping can delete. `git rev-parse --git-common-dir` resolves to the
# CANONICAL .git from any linked worktree (and to the checkout's own .git otherwise), so
# its parent is the canonical checkout root. --path-format=absolute is required: the bare
# form can return a relative `.git`, which would resolve against $_tqe_dir, not the root.
if [ -f "$_tqe_creds" ]; then
  _tqe_creds_src="local"
elif command -v git >/dev/null 2>&1; then
  _tqe_common="$(git -C "$_tqe_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [ -n "$_tqe_common" ]; then
    _tqe_canonical="$(dirname "$_tqe_common")/scripts/observability/.tempo-credentials"
    if [ -f "$_tqe_canonical" ]; then
      _tqe_creds="$_tqe_canonical"
      _tqe_creds_src="canonical checkout"
    fi
  fi
  unset _tqe_common _tqe_canonical
fi

# Target: staging (default) | prod.
_tqe_target="${TEMPO_TARGET:-staging}"
case "$_tqe_target" in
  staging|prod) ;;
  *)
    echo "ERROR: TEMPO_TARGET must be 'staging' or 'prod' (got '$_tqe_target')." >&2
    unset _tqe_dir _tqe_creds _tqe_creds_src _tqe_target
    return 1 ;;
esac

# Load the gitignored credentials file if present. It sets TEMPO_<TARGET>_* (and may
# also set the canonical TEMPO_* names directly).
if [ -n "$_tqe_creds_src" ]; then
  # shellcheck source=/dev/null
  . "$_tqe_creds"
fi

# Resolve the selected target's credential set. The tenant is resolved here (not only
# inside the escape-hatch gate below) so a hand-exported canonical trio can still pick up
# a self-hosted X-Scope-OrgID from the credentials file.
_tqe_shared_stack=0
case "$_tqe_target" in
  staging)
    _tqe_addr="${TEMPO_STAGING_ADDRESS:-}"; _tqe_user="${TEMPO_STAGING_API_USER:-}"
    _tqe_key="${TEMPO_STAGING_API_KEY:-}";  _tqe_tenant="${TEMPO_STAGING_TENANT_ID:-}"
    ;;
  prod)
    _tqe_addr="${TEMPO_PROD_ADDRESS:-}"; _tqe_user="${TEMPO_PROD_API_USER:-}"
    _tqe_key="${TEMPO_PROD_API_KEY:-}";  _tqe_tenant="${TEMPO_PROD_TENANT_ID:-}"
    # Shared-stack fallback (#949): one Grafana Cloud stack serves both environments, so
    # the staging read credentials already read prod. Fall back to them rather than fail —
    # or make the operator duplicate one token into two blocks. Only when the prod set is
    # entirely absent: a PARTIALLY filled block means a separate prod stack is genuinely
    # being configured, and the missing-variable error below names what is still needed
    # instead of silently querying the wrong stack.
    if [ -z "$_tqe_addr" ] && [ -z "$_tqe_user" ] && [ -z "$_tqe_key" ]; then
      _tqe_addr="${TEMPO_STAGING_ADDRESS:-}"; _tqe_user="${TEMPO_STAGING_API_USER:-}"
      _tqe_key="${TEMPO_STAGING_API_KEY:-}";  _tqe_tenant="${TEMPO_STAGING_TENANT_ID:-}"
      [ -n "$_tqe_addr" ] && _tqe_shared_stack=1
    fi
    ;;
esac

# An explicitly-requested TEMPO_TARGET always wins: derive the canonical vars from the
# target set even when canonical TEMPO_* are already exported (e.g. left over from a prior
# `source` for a different target — otherwise the readiness echo would say [prod] while the
# vars still point at staging). The hand-export escape hatch (keep a fully pre-set canonical
# trio) applies only when the caller did NOT request a target explicitly.
if [ -n "${TEMPO_TARGET:-}" ] || [ -z "${TEMPO_ADDRESS:-}" ] || [ -z "${TEMPO_API_USER:-}" ] || [ -z "${TEMPO_API_KEY:-}" ]; then
  TEMPO_ADDRESS="$_tqe_addr"; TEMPO_API_USER="$_tqe_user"; TEMPO_API_KEY="$_tqe_key"
  TEMPO_TENANT_ID="$_tqe_tenant"
else
  # No explicit target + a full canonical trio already exported by hand: keep it, but
  # still honor a file-provided tenant when the caller didn't set one.
  TEMPO_TENANT_ID="${TEMPO_TENANT_ID:-$_tqe_tenant}"
  _tqe_shared_stack=0
fi
unset _tqe_addr _tqe_user _tqe_key _tqe_tenant

_tqe_missing=()
[ -n "${TEMPO_ADDRESS:-}" ]  || _tqe_missing+=("TEMPO_ADDRESS")
[ -n "${TEMPO_API_USER:-}" ] || _tqe_missing+=("TEMPO_API_USER")
[ -n "${TEMPO_API_KEY:-}" ]  || _tqe_missing+=("TEMPO_API_KEY")

if [ "${#_tqe_missing[@]}" -gt 0 ]; then
  echo "ERROR: missing required variable(s) for target '$_tqe_target': ${_tqe_missing[*]}" >&2
  echo "Set them once — persisted to ~/.bashrc, outside every worktree — with:" >&2
  echo "  source $_tqe_dir/tempo-setup.sh" >&2
  echo "Or provide them by copying the template and filling in values:" >&2
  echo "  cp $_tqe_dir/.tempo-credentials.example $_tqe_dir/.tempo-credentials" >&2
  echo "Then edit that file and re-run: source ${BASH_SOURCE[0]}" >&2
  echo "(Grafana Cloud portal -> your stack -> Tempo: the query URL + numeric user ID," >&2
  echo " plus an Access Policy token with the traces:read scope. The OTLP push tokens in" >&2
  echo " GCP Secret Manager are write-only and cannot be reused for reads.)" >&2
  unset _tqe_dir _tqe_creds _tqe_creds_src _tqe_target _tqe_missing _tqe_shared_stack
  return 1
fi

export TEMPO_ADDRESS TEMPO_API_USER TEMPO_API_KEY
[ -n "${TEMPO_TENANT_ID:-}" ] && export TEMPO_TENANT_ID

if [ "$_tqe_shared_stack" = 1 ]; then
  echo "NOTE [prod]: no TEMPO_PROD_* configured — using the staging credential set."
  echo "  Staging and production push to the SAME Grafana Cloud stack, so this credential"
  echo "  already reads production traces. Scope your query to the environment:"
  echo '    { resource.deployment.environment.name = "production" }'
  _tqe_target="prod via shared stack"
fi

echo "Tempo query env ready [$_tqe_target]: TEMPO_ADDRESS=$TEMPO_ADDRESS (user=$TEMPO_API_USER, key=***)"
[ "$_tqe_creds_src" = "canonical checkout" ] && echo "  (credentials loaded from the canonical checkout: $_tqe_creds)"
unset _tqe_dir _tqe_creds _tqe_creds_src _tqe_target _tqe_missing _tqe_shared_stack
return 0
