# Branch protection — `main`

`main` requires all of the following GitHub Actions status checks to pass before a PR can merge without `--admin`:

| Required context | Source workflow | Job |
|---|---|---|
| `Lint & Test` | `.github/workflows/ci.yml` | `lint-and-test` |
| `DB Integration Tests` | `.github/workflows/ci.yml` | `db-integration` |
| `Observability Stack Smoke Test` | `.github/workflows/ci.yml` | `observability-smoke` |
| `Playwright E2E` | `.github/workflows/ci.yml` | `e2e` |
| `Staging Integration Tests` | `.github/workflows/staging.yml` | `staging-integration-tests` |
| `Review Gate` | `.github/workflows/review-gate.yml` | `evaluate-review-marker` |

The job `name:` values match the required-check contexts character-for-character — with one exception: `Review Gate` reports via the Commit Status API (`gh api .../statuses/{sha} -f context=Review Gate`), not the Checks API, so its context string is hardcoded in the workflow's script step rather than derived from the job name. See [ADR-031](../adr/ADR-031-mandatory-review-gate.md) ("Why the Commit Status API, not the Checks API") for why. Renaming any job (or, for Review Gate, changing the hardcoded `context=` value) is a breaking change to branch protection.

The job in the table above was renamed `review-gate` → `evaluate-review-marker` in [#906](https://github.com/merickvaughn/lifting-logbook/issues/906) — safe under the rule stated above, since `Review Gate`'s required context comes from the hardcoded `context=` value, not the job id. The rename only removes a visual near-collision between this non-required job's automatic Check-Run entry and the required `Review Gate` commit status in `gh pr checks` output; see `CLAUDE.md`'s `## Testing` section ("Auto-merge silently cleared — a non-required check's cancelled run") for the incident that motivated it.

## Source of truth

[`.github/expected-required-checks.json`](../../.github/expected-required-checks.json) is the canonical list of required contexts. The [`Required Checks Drift`](../../.github/workflows/required-checks-drift.yml) workflow runs weekly (Mondays 13:17 UTC) and on every push to `main` that touches the JSON file or the workflow itself. It fetches the live `required_status_checks` from the GitHub API, diffs it against the JSON, and:

- exits red and opens (or comments on the existing) issue labeled `required-checks-drift` when the two sets diverge;
- exits green and takes no other action otherwise.

When changing the required-check set, edit the JSON in the same PR that updates live branch protection. The table above must also be kept in sync — the workflow only enforces JSON-vs-live, not table-vs-JSON.

**Auth note.** The branch-protection read endpoint requires `Administration: read`, which the default `GITHUB_TOKEN` does not grant. The workflow uses a repo secret `BRANCH_PROTECTION_READ_TOKEN` — a fine-grained PAT scoped to this repo with `Administration: read` only. If the secret is missing or expired, the workflow falls back to `GITHUB_TOKEN`, which 403s on the protection endpoint and surfaces a loud-red failure rather than a silent pass. Rotate the PAT before its GitHub-emailed expiration notice and overwrite the secret via Settings → Secrets and variables → Actions (or `gh secret set BRANCH_PROTECTION_READ_TOKEN`).

## Staging-credential dependency

One of the six required checks — `Staging Integration Tests` — is gated by the staging workflow's preflight. The `staging-integration-tests` job's `if:` condition is:

```yaml
if: always() && needs.preflight.outputs.should_run == 'true'
```

`should_run` is `false` when the `GCP_STAGING_WORKLOAD_IDENTITY_PROVIDER` secret is unset. In that case the job is skipped and the required check never reports — every PR will be stuck at `mergeStateStatus: BLOCKED` until the secret is restored. If staging is intentionally decommissioned, remove `Staging Integration Tests` from `.github/expected-required-checks.json` and from live branch protection in the same PR.

The other four checks that live in `ci.yml` (`Lint & Test`, `DB Integration Tests`, `Observability Stack Smoke Test`, `Playwright E2E`) have no staging-credential dependency. `Review Gate` (its own workflow, `review-gate.yml`) likewise has no staging-credential dependency, but has its own fail-open behavior on `gh`/network errors and on an unparseable `merge_group` PR-number resolution — see [ADR-031](../adr/ADR-031-mandatory-review-gate.md).

## Inspecting and updating

```bash
# Inspect current required checks
gh api repos/merickvaughn/lifting-logbook/branches/main/protection/required_status_checks

# Update (full replacement of the contexts list)
gh api -X PATCH repos/merickvaughn/lifting-logbook/branches/main/protection/required_status_checks \
  -F strict=true \
  -f 'contexts[]=Lint & Test' \
  -f 'contexts[]=DB Integration Tests' \
  -f 'contexts[]=Observability Stack Smoke Test' \
  -f 'contexts[]=Playwright E2E' \
  -f 'contexts[]=Staging Integration Tests' \
  -f 'contexts[]=Review Gate'
```

`strict=true` means PRs must be up to date with `main` before the checks count.

## Merge queue readiness

[#673](https://github.com/merickvaughn/lifting-logbook/issues/673) diagnosed a live-lock: concurrent PR throughput causes `staging.yml`'s deploy jobs (which share a global, not per-PR, concurrency group) to cancel each other's queued runs, which `Staging Integration Tests` then hard-fails on — compounding with `strict: true` above. The fix is GitHub's native merge queue, which serializes required-check re-validation at the front of one queue.

As of [#694](https://github.com/merickvaughn/lifting-logbook/issues/694), both required-check workflows (`ci.yml` and `staging.yml`) also trigger on `merge_group`, with `github.event.pull_request.*` context references made merge_group-safe throughout (concurrency groups, the fork-repo guard, image tagging, the `dorny/paths-filter` preflight diff, and skipping the PR-comment-only `report-status` job). See [ADR-030](../adr/ADR-030-github-merge-queue-adoption.md) for the full decision record.

**"Require merge queue" is ENABLED on `main`** as of 2026-07-22 ([#695](https://github.com/merickvaughn/lifting-logbook/issues/695), unblocked by the [#729](https://github.com/merickvaughn/lifting-logbook/issues/729) transfer to the `merickvaughn` organization — merge queue requires org ownership regardless of repo visibility). Live configuration:

| Setting | Value | Why |
|---|---|---|
| Merge method | **Squash** | Matches the repo-wide squash-only merge strategy (keeps `main` linear). |
| **Build concurrency** | **1** | The one setting that actually fixes [#673](https://github.com/merickvaughn/lifting-logbook/issues/673): only one queue entry re-validates at a time, so the *global* `staging-deploy-mutex-api`/`-web` groups become uncontended rather than merely tolerated. Raising this reintroduces the cancellation cascade. |
| Merge limits | min 1 / max 5 entries | GitHub defaults; not load-bearing for #673. |
| Require branches up to date (`strict`) | `true` (unchanged) | The queue, not the contributor, now satisfies it — that is the point of adopting it. |

### Verifying the merge queue setting

**The classic REST branch-protection endpoint does not reliably surface merge-queue state** — `gh api repos/merickvaughn/lifting-logbook/branches/main/protection` returns no `required_merge_queue` key even when the queue is live, and `.../rulesets` is empty because the queue is configured on the classic branch-protection rule rather than a ruleset. Reading either one alone produces a false "not enabled". Query GraphQL instead, which is authoritative:

```bash
gh api graphql -f query='
query {
  repository(owner:"merickvaughn", name:"lifting-logbook") {
    mergeQueue(branch:"main") {
      id
      configuration { mergeMethod mergingStrategy maximumEntriesToBuild maximumEntriesToMerge minimumEntriesToMerge }
      entries(first:5) { totalCount }
    }
  }
}'
```

A non-null `mergeQueue.id` means the queue exists; `maximumEntriesToBuild` is the Build Concurrency value in the table above. See [ADR-030](../adr/ADR-030-github-merge-queue-adoption.md) for the full decision record and its 2026-07-22 amendment.
