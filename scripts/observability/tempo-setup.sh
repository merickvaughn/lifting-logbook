#!/usr/bin/env bash
# tempo-setup.sh — one-time interactive setup for Grafana Cloud Tempo *read* creds (bash).
#
# Purpose:   The Tempo counterpart of mimir-setup.sh. Prompts for TEMPO_STAGING_ADDRESS /
#            TEMPO_STAGING_API_USER / TEMPO_STAGING_API_KEY (token input hidden) plus an
#            optional TEMPO_STAGING_TENANT_ID, then persists them to ~/.bashrc so every new
#            Git Bash shell exports them. When SOURCED, also exports into the current shell
#            so you can query immediately without reopening a terminal.
#
# Why this exists (#949): the only working `traces:read` credential on this machine once
#            lived inside a disposable git worktree under .claude/worktrees/, which a daily
#            prune routine can delete without warning — and the file is gitignored, so it is
#            not recoverable from git. ~/.bashrc is outside every worktree and every
#            checkout, so a prune cannot reach it, and because the values arrive as
#            environment variables they resolve from ANY worktree, not just the one that
#            happens to hold the credentials file.
#
# Usage:     # recommended — updates the current shell too:
#            source scripts/observability/tempo-setup.sh
#
#            # or run it — persists for NEW shells; for the current one, then do:
#            scripts/observability/tempo-setup.sh && source ~/.bashrc
#
#            Afterwards: scripts/observability/tempo-query.sh tags
#
# Scope:     the token MUST be an Access Policy token scoped to `traces:read` ONLY.
#            tempo-query.sh issues nothing but HTTP GETs. Note the OTLP push tokens held in
#            GCP Secret Manager (lifting-logbook-{stg,prod}-otel-otlp-auth-header) are
#            WRITE-ONLY — their policy grants traces:write with no traces:read — so they
#            cannot be reused here; a distinct read token is genuinely required (#949).
#
# Staging only: staging and production push to the SAME Grafana Cloud stack, so one
#            credential set reads both and `deployment.environment.name` is the only
#            discriminator. tempo-query-env.sh falls back to this staging set when
#            TEMPO_TARGET=prod finds no TEMPO_PROD_* — so there is nothing extra to enter
#            here. If a genuinely separate prod stack is ever provisioned, add a
#            TEMPO_PROD_* block to scripts/observability/.tempo-credentials (see
#            .tempo-credentials.example) and it will take precedence over the fallback.
#
# SECURITY:  the values (including the token) are written in plaintext to ~/.bashrc —
#            the trade-off for "persist permanently", the same one mimir-setup.sh makes.
#            Remove them later with:
#            sed -i '/# >>> tempo-query-env >>>/,/# <<< tempo-query-env <<</d' ~/.bashrc

# NOTE: no `set -e` — this script is meant to be sourced, where `set -e` would leak
# into and could kill the user's interactive shell.

_tset_sourced=0
(return 0 2>/dev/null) && _tset_sourced=1

_tset_fail() { if [ "$_tset_sourced" = 1 ]; then return "$1"; else exit "$1"; fi; }

_tset_bashrc="${HOME}/.bashrc"
_tset_begin="# >>> tempo-query-env >>>"
_tset_end="# <<< tempo-query-env <<<"

# Prompt, offering the current value (if any) as the default.
_tset_ask() {
  local prompt="$1" current="$2" ans
  if [ -n "$current" ]; then
    read -r -p "$prompt [$current]: " ans
    [ -z "$ans" ] && ans="$current"
  else
    read -r -p "$prompt: " ans
  fi
  printf '%s' "$ans"
}

echo "Grafana Cloud Tempo — one-time read-credential setup (bash)"
echo "Find these in the Grafana Cloud portal -> your stack -> Tempo."
echo "The token must be an Access Policy token scoped to traces:read (read-only)."
echo

_tset_addr="$(_tset_ask 'TEMPO_STAGING_ADDRESS (Tempo QUERY base URL, so ${ADDRESS}/api/search resolves)' "${TEMPO_STAGING_ADDRESS:-}")"
_tset_user="$(_tset_ask 'TEMPO_STAGING_API_USER (numeric instance / user ID)' "${TEMPO_STAGING_API_USER:-}")"
read -r -s -p "TEMPO_STAGING_API_KEY (Access Policy token, traces:read) — input hidden: " _tset_key
echo
_tset_tenant="$(_tset_ask 'TEMPO_STAGING_TENANT_ID (optional — self-hosted Tempo only; blank for Grafana Cloud)' "${TEMPO_STAGING_TENANT_ID:-}")"

if [ -z "$_tset_addr" ] || [ -z "$_tset_user" ] || [ -z "$_tset_key" ]; then
  echo "ERROR: TEMPO_STAGING_ADDRESS, TEMPO_STAGING_API_USER and TEMPO_STAGING_API_KEY are all required. Nothing saved." >&2
  unset _tset_addr _tset_user _tset_key _tset_tenant
  _tset_fail 1
else

touch "$_tset_bashrc"

# Drop any previous managed block (exact-line match — no regex escaping headaches).
if grep -qF "$_tset_begin" "$_tset_bashrc"; then
  awk -v b="$_tset_begin" -v e="$_tset_end" '
    $0==b {skip=1; next}
    skip && $0==e {skip=0; next}
    !skip {print}
  ' "$_tset_bashrc" > "$_tset_bashrc.tset.tmp" && mv "$_tset_bashrc.tset.tmp" "$_tset_bashrc"
fi

# Append a fresh block. %q makes each value safe to re-source verbatim.
{
  echo ""
  echo "$_tset_begin"
  echo "# Written by scripts/observability/tempo-setup.sh — do not edit by hand."
  printf 'export TEMPO_STAGING_ADDRESS=%q\n' "$_tset_addr"
  printf 'export TEMPO_STAGING_API_USER=%q\n' "$_tset_user"
  printf 'export TEMPO_STAGING_API_KEY=%q\n' "$_tset_key"
  [ -n "$_tset_tenant" ] && printf 'export TEMPO_STAGING_TENANT_ID=%q\n' "$_tset_tenant"
  echo "$_tset_end"
} >> "$_tset_bashrc"

# Export into the current shell too (effective immediately when sourced).
export TEMPO_STAGING_ADDRESS="$_tset_addr"
export TEMPO_STAGING_API_USER="$_tset_user"
export TEMPO_STAGING_API_KEY="$_tset_key"
[ -n "$_tset_tenant" ] && export TEMPO_STAGING_TENANT_ID="$_tset_tenant"

echo
echo "Saved to $_tset_bashrc (permanent for new Git Bash shells, and outside every worktree):"
echo "  TEMPO_STAGING_ADDRESS  = $_tset_addr"
echo "  TEMPO_STAGING_API_USER = $_tset_user"
echo "  TEMPO_STAGING_API_KEY  = *** (hidden)"
[ -n "$_tset_tenant" ] && echo "  TEMPO_STAGING_TENANT_ID = $_tset_tenant"
echo
if [ "$_tset_sourced" = 1 ]; then
  echo "This shell now has them exported; new shells inherit them from ~/.bashrc."
else
  echo "NOTE: run in a subshell — this shell does not have them yet. Open a new Git Bash,"
  echo "or run:  source ~/.bashrc"
fi
echo
echo "Next: scripts/observability/tempo-query.sh tags     # smoke-test the credentials"

fi

unset _tset_sourced _tset_bashrc _tset_begin _tset_end _tset_addr _tset_user _tset_key _tset_tenant
unset -f _tset_ask _tset_fail 2>/dev/null
