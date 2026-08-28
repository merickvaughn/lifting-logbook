#!/usr/bin/env bash
# mimir-setup.sh — one-time interactive setup for Grafana Cloud Mimir query creds (bash).
#
# Purpose:   The bash counterpart of mimir-setup.ps1. Prompts for MIMIR_ADDRESS /
#            MIMIR_API_USER / MIMIR_API_KEY (token input hidden) plus optional
#            MIMIR_QUERY_URL / MIMIR_TENANT_ID, then persists them to ~/.bashrc so every
#            new Git Bash shell exports them. When SOURCED, also exports into the current
#            shell so you can run the queries immediately without reopening.
#
# Usage:     # recommended — updates the current shell too:
#            source scripts/observability/mimir-setup.sh
#
#            # or run it — persists for NEW shells; for the current one, then do:
#            scripts/observability/mimir-setup.sh && source ~/.bashrc
#
#            Afterwards: scripts/observability/run-calibration-queries.sh
#
# SECURITY:  the values (including the token) are written in plaintext to ~/.bashrc —
#            the trade-off for "persist permanently". Remove them later with:
#            sed -i '/# >>> mimir-query-env >>>/,/# <<< mimir-query-env <<</d' ~/.bashrc
#
# BACKUP:    replacing the managed block rewrites the WHOLE of ~/.bashrc, a file this script
#            does not own and which holds arbitrary unrelated content. Two guards, per the
#            "Back up before you mutate" rule (#954):
#              1. ~/.bashrc.mimir-setup.orig — a written-if-absent anchor capturing the state
#                 before this script ever ran. Never overwritten on re-run, so repeated runs
#                 cannot erode the original; delete it deliberately to re-baseline. Restore
#                 with:  cp ~/.bashrc.mimir-setup.orig ~/.bashrc
#                 The anchor is a VERBATIM copy, so if an earlier run already saved a token to
#                 ~/.bashrc the anchor holds that token too — the same plaintext trade-off as
#                 above. `cp -p` carries the original's mode across rather than widening it.
#              2. The rewrite is verified by line count before it replaces the original. A
#                 disk-full `awk` can emit a short file and still exit 0 (see the global
#                 CLAUDE.md ENOSPC note — its signature is exactly "truncated output, exit 0"),
#                 so exit status alone is not sufficient evidence the write is complete.

# NOTE: no `set -e` — this script is meant to be sourced, where `set -e` would leak
# into and could kill the user's interactive shell.

_mset_sourced=0
(return 0 2>/dev/null) && _mset_sourced=1

_mset_bashrc="${HOME}/.bashrc"
_mset_anchor="${HOME}/.bashrc.mimir-setup.orig"
_mset_begin="# >>> mimir-query-env >>>"
_mset_end="# <<< mimir-query-env <<<"

# Abort flag rather than an early `return`: when this script is sourced, a `return` inside a
# helper function only leaves that function — execution would carry on and save anyway. Every
# failure path below sets this, and each subsequent stage is gated on it.
_mset_abort=0

# Prompt, offering the current value (if any) as the default.
_mset_ask() {
  local prompt="$1" current="$2" ans
  if [ -n "$current" ]; then
    read -r -p "$prompt [$current]: " ans
    [ -z "$ans" ] && ans="$current"
  else
    read -r -p "$prompt: " ans
  fi
  printf '%s' "$ans"
}

echo "Grafana Cloud Mimir — one-time credential setup (bash)"
echo "Find these in the Grafana Cloud portal -> your stack -> Prometheus."
echo

_mset_addr="$(_mset_ask 'MIMIR_ADDRESS (Prometheus query/remote-write URL base)' "${MIMIR_ADDRESS:-}")"
_mset_user="$(_mset_ask 'MIMIR_API_USER (numeric instance / user ID)' "${MIMIR_API_USER:-}")"
read -r -s -p "MIMIR_API_KEY (Access Policy token, metrics:read) — input hidden: " _mset_key
echo
_mset_qurl="$(_mset_ask 'MIMIR_QUERY_URL (optional — blank unless ${MIMIR_ADDRESS}/api/v1/query is wrong)' "${MIMIR_QUERY_URL:-}")"
_mset_tenant="$(_mset_ask 'MIMIR_TENANT_ID (optional — self-hosted Mimir only; blank for Grafana Cloud)' "${MIMIR_TENANT_ID:-}")"

if [ -z "$_mset_addr" ] || [ -z "$_mset_user" ] || [ -z "$_mset_key" ]; then
  echo "ERROR: MIMIR_ADDRESS, MIMIR_API_USER and MIMIR_API_KEY are all required. Nothing saved." >&2
  _mset_abort=1
fi

if [ "$_mset_abort" = 0 ]; then
  touch "$_mset_bashrc"

  # Written-if-absent anchor: ~/.bashrc as it stood before this script ever touched it. Kept
  # across re-runs, so an accumulation of runs cannot erode the original. Refuse to mutate at
  # all if it cannot be captured — an un-backed-up rewrite of the user's shell config is not a
  # trade worth making for a convenience script.
  if [ ! -f "$_mset_anchor" ] && ! cp -p "$_mset_bashrc" "$_mset_anchor"; then
    echo "ERROR: could not write the backup $_mset_anchor — refusing to modify $_mset_bashrc." >&2
    echo "Nothing was saved. Fix the backup failure (disk space? permissions?) and re-run." >&2
    _mset_abort=1
  fi
fi

# Drop any previous managed block (exact-line match — no regex escaping headaches).
if [ "$_mset_abort" = 0 ] && grep -qF "$_mset_begin" "$_mset_bashrc"; then
  # Count what the rewrite should remove: the delimiters and everything between them. This
  # mirrors the removal awk exactly, so the expected output length is known in advance.
  _mset_before="$(wc -l < "$_mset_bashrc")"
  _mset_blocklines="$(awk -v b="$_mset_begin" -v e="$_mset_end" '
    $0==b {s=1} s {n++} s && $0==e {s=0} END {print n+0}
  ' "$_mset_bashrc")"
  _mset_expected=$(( _mset_before - _mset_blocklines ))

  awk -v b="$_mset_begin" -v e="$_mset_end" '
    $0==b {skip=1; next}
    skip && $0==e {skip=0; next}
    !skip {print}
  ' "$_mset_bashrc" > "$_mset_bashrc.mset.tmp"
  _mset_rc=$?
  _mset_after="$(wc -l < "$_mset_bashrc.mset.tmp" 2>/dev/null || echo -1)"

  # `-ge`, not `-eq`: awk always terminates its final line, so a source file lacking a trailing
  # newline legitimately yields one MORE line than wc counted for it. A count BELOW the
  # expectation is a short write — that is the case worth refusing.
  if [ "$_mset_rc" -eq 0 ] && [ "$_mset_after" -ge "$_mset_expected" ]; then
    mv "$_mset_bashrc.mset.tmp" "$_mset_bashrc"
  else
    rm -f "$_mset_bashrc.mset.tmp"
    echo "ERROR: rewriting $_mset_bashrc produced $_mset_after lines, expected at least $_mset_expected." >&2
    echo "The original is UNTOUCHED and nothing was saved. A short write usually means a full disk." >&2
    echo "Backup of the pre-mimir-setup state: $_mset_anchor" >&2
    _mset_abort=1
  fi
  unset _mset_before _mset_blocklines _mset_expected _mset_rc _mset_after
fi

if [ "$_mset_abort" = 0 ]; then
  # Append a fresh block. %q makes each value safe to re-source verbatim.
  {
    echo ""
    echo "$_mset_begin"
    echo "# Written by scripts/observability/mimir-setup.sh — do not edit by hand."
    printf 'export MIMIR_ADDRESS=%q\n' "$_mset_addr"
    printf 'export MIMIR_API_USER=%q\n' "$_mset_user"
    printf 'export MIMIR_API_KEY=%q\n' "$_mset_key"
    [ -n "$_mset_qurl" ]   && printf 'export MIMIR_QUERY_URL=%q\n' "$_mset_qurl"
    [ -n "$_mset_tenant" ] && printf 'export MIMIR_TENANT_ID=%q\n' "$_mset_tenant"
    echo "$_mset_end"
  } >> "$_mset_bashrc"

  # Export into the current shell too (effective immediately when sourced).
  export MIMIR_ADDRESS="$_mset_addr"
  export MIMIR_API_USER="$_mset_user"
  export MIMIR_API_KEY="$_mset_key"
  [ -n "$_mset_qurl" ]   && export MIMIR_QUERY_URL="$_mset_qurl"
  [ -n "$_mset_tenant" ] && export MIMIR_TENANT_ID="$_mset_tenant"

  echo
  echo "Saved to $_mset_bashrc (permanent for new Git Bash shells):"
  echo "  MIMIR_ADDRESS  = $_mset_addr"
  echo "  MIMIR_API_USER = $_mset_user"
  echo "  MIMIR_API_KEY  = *** (hidden)"
  [ -n "$_mset_qurl" ]   && echo "  MIMIR_QUERY_URL = $_mset_qurl"
  [ -n "$_mset_tenant" ] && echo "  MIMIR_TENANT_ID = $_mset_tenant"
  echo "Backup of the pre-mimir-setup state: $_mset_anchor"
  echo
  if [ "$_mset_sourced" = 1 ]; then
    echo "This shell now has them exported; new shells inherit them from ~/.bashrc."
  else
    echo "NOTE: run in a subshell — this shell does not have them yet. Open a new Git Bash,"
    echo "or run:  source ~/.bashrc"
  fi
  echo
  echo "Next: scripts/observability/run-calibration-queries.sh"
fi

_mset_status="$_mset_abort"
unset _mset_sourced _mset_bashrc _mset_anchor _mset_begin _mset_end _mset_abort \
      _mset_addr _mset_user _mset_key _mset_qurl _mset_tenant
unset -f _mset_ask 2>/dev/null

if [ "$_mset_status" = 1 ]; then
  unset _mset_status
  # `return` when sourced, `exit` when executed — probed rather than assumed, so the caller's
  # shell is never killed by an `exit` in a sourced script.
  (return 0 2>/dev/null) && return 1 || exit 1
fi
unset _mset_status
