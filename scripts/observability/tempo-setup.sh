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
#
# BACKUP:    replacing the managed block rewrites the WHOLE of ~/.bashrc, a file this script
#            does not own and which holds arbitrary unrelated content. Two guards, per the
#            "Back up before you mutate" rule:
#              1. ~/.bashrc.tempo-setup.orig — a written-if-absent anchor capturing the state
#                 before this script ever ran. Never overwritten on re-run, so repeated runs
#                 cannot erode the original; delete it deliberately to re-baseline. Restore
#                 with:  cp ~/.bashrc.tempo-setup.orig ~/.bashrc
#              2. The rewrite is verified by line count before it replaces the original. A
#                 disk-full `awk` can emit a short file and still exit 0 (see the global
#                 CLAUDE.md ENOSPC note — its signature is exactly "truncated output, exit 0"),
#                 so exit status alone is not sufficient evidence the write is complete.

# NOTE: no `set -e` — this script is meant to be sourced, where `set -e` would leak
# into and could kill the user's interactive shell.

_tset_sourced=0
(return 0 2>/dev/null) && _tset_sourced=1

_tset_bashrc="${HOME}/.bashrc"
_tset_anchor="${HOME}/.bashrc.tempo-setup.orig"
_tset_begin="# >>> tempo-query-env >>>"
_tset_end="# <<< tempo-query-env <<<"

# Abort flag rather than an early `return`: when this script is sourced, a `return` inside a
# helper function only leaves that function — execution would carry on and save anyway. Every
# failure path below sets this, and each subsequent stage is gated on it.
_tset_abort=0

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
  _tset_abort=1
fi

if [ "$_tset_abort" = 0 ]; then
  touch "$_tset_bashrc"

  # Written-if-absent anchor: ~/.bashrc as it stood before this script ever touched it. Kept
  # across re-runs, so an accumulation of runs cannot erode the original. Refuse to mutate at
  # all if it cannot be captured — an un-backed-up rewrite of the user's shell config is not a
  # trade worth making for a convenience script.
  if [ ! -f "$_tset_anchor" ] && ! cp -p "$_tset_bashrc" "$_tset_anchor"; then
    echo "ERROR: could not write the backup $_tset_anchor — refusing to modify $_tset_bashrc." >&2
    echo "Nothing was saved. Fix the backup failure (disk space? permissions?) and re-run." >&2
    _tset_abort=1
  fi
fi

# Drop any previous managed block (exact-line match — no regex escaping headaches).
if [ "$_tset_abort" = 0 ] && grep -qF "$_tset_begin" "$_tset_bashrc"; then
  # Count what the rewrite should remove: the delimiters and everything between them. This
  # mirrors the removal awk exactly, so the expected output length is known in advance.
  _tset_before="$(wc -l < "$_tset_bashrc")"
  _tset_blocklines="$(awk -v b="$_tset_begin" -v e="$_tset_end" '
    $0==b {s=1} s {n++} s && $0==e {s=0} END {print n+0}
  ' "$_tset_bashrc")"
  _tset_expected=$(( _tset_before - _tset_blocklines ))

  awk -v b="$_tset_begin" -v e="$_tset_end" '
    $0==b {skip=1; next}
    skip && $0==e {skip=0; next}
    !skip {print}
  ' "$_tset_bashrc" > "$_tset_bashrc.tset.tmp"
  _tset_rc=$?
  _tset_after="$(wc -l < "$_tset_bashrc.tset.tmp" 2>/dev/null || echo -1)"

  # `-ge`, not `-eq`: awk always terminates its final line, so a source file lacking a trailing
  # newline legitimately yields one MORE line than wc counted for it. A count BELOW the
  # expectation is a short write — that is the case worth refusing.
  if [ "$_tset_rc" -eq 0 ] && [ "$_tset_after" -ge "$_tset_expected" ]; then
    mv "$_tset_bashrc.tset.tmp" "$_tset_bashrc"
  else
    rm -f "$_tset_bashrc.tset.tmp"
    echo "ERROR: rewriting $_tset_bashrc produced $_tset_after lines, expected at least $_tset_expected." >&2
    echo "The original is UNTOUCHED and nothing was saved. A short write usually means a full disk." >&2
    echo "Backup of the pre-tempo-setup state: $_tset_anchor" >&2
    _tset_abort=1
  fi
  unset _tset_before _tset_blocklines _tset_expected _tset_rc _tset_after
fi

if [ "$_tset_abort" = 0 ]; then
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
  echo "Backup of the pre-tempo-setup state: $_tset_anchor"
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

_tset_status="$_tset_abort"
unset _tset_sourced _tset_bashrc _tset_anchor _tset_begin _tset_end _tset_abort \
      _tset_addr _tset_user _tset_key _tset_tenant
unset -f _tset_ask 2>/dev/null

if [ "$_tset_status" = 1 ]; then
  unset _tset_status
  # `return` when sourced, `exit` when executed — probed rather than assumed, so the caller's
  # shell is never killed by an `exit` in a sourced script.
  (return 0 2>/dev/null) && return 1 || exit 1
fi
unset _tset_status
