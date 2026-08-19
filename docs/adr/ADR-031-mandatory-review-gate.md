# ADR-031: Mandatory Review Gate via GitHub Required Status Check

**Status:** Accepted — implemented in the PR that closes
[#757](https://github.com/merickvaughn/lifting-logbook/issues/757). See "Implementation" below.
**Date:** 2026-07-06
**Closes:** [#718](https://github.com/merickvaughn/lifting-logbook/issues/718) (staged across
[#720](https://github.com/merickvaughn/lifting-logbook/issues/720) — this workflow, shipped but not
yet required — and [#757](https://github.com/merickvaughn/lifting-logbook/issues/757), which rolls out
the branch-protection change now that #720 is proven green)
**Related:** dev-env [ADR-083](https://github.com/brownm09/dev-env/blob/main/docs/adr/083-auto-merge-checkpoint-gate.md)
(the complementary client-side hook for the Claude-Code-mediated `--auto` path this check does not
replace), [ADR-030](ADR-030-github-merge-queue-adoption.md) (this check ships `merge_group`-ready
from day one rather than needing a later retrofit)

---

## Context

Nothing today enforces, at the GitHub level, that a code review took place before a PR merges.
The existing enforcement is dev-env's `pre-merge-findings-gate.py` — a Claude Code `PreToolUse`
hook that intercepts `gh pr merge` Bash calls and blocks the merge if `/review` found findings
that were never disposed. That hook only ever sees a Bash tool call made *inside a Claude Code
session*. It cannot see, and structurally never can see, a human merging via the GitHub web UI,
or a merge GitHub's own auto-merge feature finalizes once CI goes green.

dev-env's [ADR-083](https://github.com/brownm09/dev-env/blob/main/docs/adr/083-auto-merge-checkpoint-gate.md)
ships a hook covering three checkpoints for `--auto` invoked from a Claude Code session, but its
own Consequences section names this exact gap as an accepted limitation, and its 2026-07-06
addendum recommends closing it with a genuine GitHub-side required status check for the
review-completion checkpoint specifically — the one checkpoint that reduces to pure marker-text
detection rather than the judgment calls the other two require.

## Decision

Add a required GitHub status check, **"Review Gate"**, implemented as
[`.github/workflows/review-gate.yml`](../../.github/workflows/review-gate.yml). It reads the same
`/review` marker comment (`<!-- review-findings: blocking=N non_blocking=M -->`) and PR-body
disposition section the dev-env hook already uses, and reports pass/fail as a commit status.

**Review is mandatory, not merely disposition-enforced.** A PR with no `/review` marker at all
**fails** the check. This is a deliberate departure from the dev-env hook's lenient behavior
(no marker = pass there, since review is optional today and only finding-disposition is
enforced) — every PR, including trivial ones, now needs a passing `/review` before it can merge,
once this check is made required.

**Shipping and requiring are two separate PRs.** This ADR's PR ships the workflow only — it is
not yet added to branch protection, so it cannot self-block. A follow-up PR performs the
branch-protection mutation (with a snapshot-before-mutate backup) once the workflow is confirmed
green on a real PR.

## Rationale

**Why mandatory, not parity with the existing hook.** The hook's leniency exists because review
is currently optional by convention, not by design intent — the documented workflow
(`gh pr create → stub → /compact → /review --post-comment → address findings → merge`) already
expects `/review` to run on every PR. Making it GitHub-enforced converts a discipline-only
expectation into a mechanical guarantee, consistent with this environment's broader pattern of
closing "the session has to remember" gaps (dev-env ADR-071, ADR-045, ADR-048) rather than
accepting them indefinitely.

**Why the Commit Status API, not the Checks API.** Branch protection's required-check matching is
API-agnostic — it matches on context/check name, not which API reported it. The review marker
arrives via a PR *comment*, which fires an `issue_comment` event with no natural check-suite
association; Checks-API check-run creation is reliable mainly for `pull_request`-triggered runs,
exactly the case this workflow's other trigger is not. The Commit Status API
([reference](https://docs.github.com/en/rest/commits/statuses)) needs only `statuses: write` on
the default `GITHUB_TOKEN` and attaches directly to a specific SHA regardless of triggering event.

**Why `merge_group` support ships now, not as a retrofit.** [ADR-030](ADR-030-github-merge-queue-adoption.md)
established that every required-check workflow must trigger on `merge_group`
([GitHub Actions docs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#merge_group))
so the check reports against the queue's synthetic validation commit, not only the PR's own head
SHA — `ci.yml`/`staging.yml` needed a follow-up PR (#696) to retrofit this. Merge queue enablement
itself is still pending ([#695](https://github.com/merickvaughn/lifting-logbook/issues/695), open),
but adding `merge_group` support to a brand-new required-check-eligible workflow at creation time
avoids repeating that same retrofit here. `merge_group` events expose no PR number directly
(`context.issue.number` is undefined, confirmed in #696's implementation) — this workflow resolves
it by parsing `pr-<number>-` out of `github.event.merge_group.head_ref`, GitHub's documented
merge-queue temporary-branch naming
([GitHub docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
Freshness is still compared against the **PR's own head commit's** `committedDate`, not the
synthetic merge-queue commit's date — the latter is always "now" at queue-processing time and
would make the freshness check meaningless.

**Why fail OPEN on error, unlike dev-env's stricter sibling hook.** dev-env's
`pre-auto-merge-checkpoint-gate.py` fails closed deliberately, but it only ever gates the rare,
opt-in `--auto` path, where a plain-merge fallback always exists. This check, once required, gates
**every** merge in the repo with no fallback path — a transient `gh`/GitHub API error, or a failure
to parse a PR number out of a `merge_group` ref, must not block all merges repo-wide. Both cases
fail open (pass, with a `::warning::` annotation) rather than closed.

## Consequences

**Positive:**
- Closes a gap the dev-env hook can never close by construction (no Bash call to intercept for a
  human or web-UI-triggered merge).
- Generalizes the existing `/review` marker convention to a GitHub-native enforcement point,
  independent of which client or session triggers the merge.
- Ships merge-queue-ready, avoiding a predictable future retrofit PR.

**Negative / accepted:**
- **Real workflow change once required (sub-issue 2):** every PR, including trivial docs/config
  changes, needs a passing `/review` before merge. This is intentional (see Rationale) but is a
  behavior change from today, where review is optional.
- **Fail-open on error is a real, accepted gap**, symmetric to the hook's own accepted
  comment-authenticity gap (ADR-083's Consequences): a transient error, or a malformed
  `merge_group.head_ref`, lets a PR through without the check having meaningfully evaluated
  anything. Chosen because the alternative (fail closed, repo-wide, no override) risks a stuck
  repo over a transient fault — judged the worse failure mode for a solo-maintainer, high-PR-
  throughput repo.
- **Comment-body authenticity is not verified**, same accepted limitation as the dev-env hook:
  anyone with comment access to the PR could hand-write the marker text. Accepted for the same
  reason ADR-083 accepts it — disproportionate scope creep for this repo's threat model.

## Implementation

[#757](https://github.com/merickvaughn/lifting-logbook/issues/757) (2026-07-08) added `Review Gate` to
`main`'s branch-protection `required_status_checks.contexts`, alongside the five pre-existing
contexts (`Lint & Test`, `DB Integration Tests`, `Observability Stack Smoke Test`,
`Playwright E2E`, `Staging Integration Tests`) via a full-replacement `PATCH` — the same mutation
shape as the `gh api -X PATCH` example in
[`docs/operations/branch-protection.md`](../operations/branch-protection.md). Live state was
snapshotted to `.claude/backups/branch-protection-snapshot-*.json` before mutating, and
`.github/expected-required-checks.json` plus the branch-protection doc's table were updated in the
same PR so the `Required Checks Drift` workflow does not immediately flag the new live state as
unexpected.

This closes the enforcement half of the gap #718 opened for: a human merging via the GitHub web UI,
or GitHub's own auto-merge firing once CI is green, can no longer bypass review-findings
enforcement on this repo — `Review Gate` now mechanically blocks any PR without a fresh, clean (or
disposed) `/review` marker, regardless of who or what triggers the merge. See dev-env
[ADR-083](https://github.com/brownm09/dev-env/blob/main/docs/adr/083-auto-merge-checkpoint-gate.md)'s
dated addenda for the cross-repo history of this rollout, including the addendum this
implementation prompted.

## Escalation trigger

Revisit if:
- `merge_group.head_ref`'s `pr-<number>-` format changes or fails to resolve in practice once
  [#695](https://github.com/merickvaughn/lifting-logbook/issues/695) enables the merge queue live —
  fix promptly; blast radius is bounded to fail-open (reduced enforcement), not a stuck queue, per
  the safe-fallback design above.
- The fail-open error rate in practice turns out non-trivial (i.e., the check routinely passes
  PRs it should have evaluated) — would justify revisiting the fail-open choice.

## References

- [GitHub REST API — Commit statuses](https://docs.github.com/en/rest/commits/statuses) — the API
  this check reports through, and why it needs only `statuses: write`.
- [GitHub REST API — Checks](https://docs.github.com/en/rest/checks) — the alternative considered
  and not used, for the reasons in Rationale.
- [GitHub Docs — Troubleshooting required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks) —
  confirms checks and commit statuses are matched in the same name-based namespace, independent of
  which API reported them (link updated 2026-08-19 — the page originally cited here 404s, confirmed
  live; GitHub appears to have reorganized its docs since this ADR was written).
- [GitHub Actions — Events that trigger workflows § `issue_comment`](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#issue_comment) —
  confirms PR comments fire `issue_comment`, not `pull_request`.
- [GitHub Actions — Events that trigger workflows § `merge_group`](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#merge_group) —
  the event this check also triggers on per ADR-030's convention.
- [GitHub Docs — Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) —
  documents the `gh-readonly-queue/<base>/pr-<number>-<sha>` temporary branch naming this
  workflow's PR-number resolution depends on.
- dev-env [ADR-083 — Mechanical Pre-Check Gate for `gh pr merge --auto` Checkpoints](https://github.com/brownm09/dev-env/blob/main/docs/adr/083-auto-merge-checkpoint-gate.md) —
  the complementary client-side hook this check does not replace, and its 2026-07-06 addendum
  recommending this design.
- [ADR-030 — GitHub Merge Queue Adoption](ADR-030-github-merge-queue-adoption.md) — the
  `merge_group` convention this check follows from day one.
