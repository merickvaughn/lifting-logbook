# Claude Code — Lifting Logbook

This file is read automatically by Claude Code at the start of every session.
It replaces the need to paste platform constraints or workflow conventions into your opening brief.
Include in your opening brief only: the issue you are working on, current branch state, and any carry-over context this file cannot know.

---

## Platform & Environment

- **OS:** Windows 11, Git Bash terminal
- **Node:** 20.11.1 (managed by nvm for Windows; `.nvmrc` is set — run `nvm use $(cat .nvmrc)` at session start if not already active).
  - **Windows npm-install tarball extraction (any Node version):** `npm install` on Windows occasionally extracts dependency tarballs incompletely — reproduces on Node 24 and on the currently-pinned Node 20.11.1 alike, so this is a Windows/npm reliability issue independent of Node version, not a Node-24-specific one. Observed failure shapes:
    - Missing or truncated declared `types/` content: `node_modules/light-my-request/types/index.d.ts` cut mid-type; `@testing-library/react` and `@vercel/otel` with the declared `types/`/`dist/types/` directory absent entirely despite `package.json` pointing at it.
    - Regular (non-types) lib file or directory missing entirely: `node_modules/iconv-lite/lib/`; `iterare` missing `lib/utils.js`; `node_modules/turbo` missing `.bin/turbo`.
    - Malformed or truncated native binary: `node_modules/@turbo/windows-64/bin/turbo.exe` failing with `EFTYPE`; `@next/swc-win32-x64-msvc`'s native `.node` binary present but invalid ("not a valid Win32 application").
    - Dependency fully unresolvable ("Module not found") despite npm reporting a successful install: `@clerk/clerk-react` unresolvable from `@clerk/nextjs`.

    Downstream failures: `nest build` CJS resolution errors (`iconv-lite/lib/streams`, `minimatch/dist/commonjs/index.js`), `TS1110 Type expected` from `light-my-request`, `TS7016 Could not find a declaration file` from `@testing-library/react`/`@vercel/otel`, `spawnSync ... EFTYPE` or `"not a valid Win32 application"` from turbo/next-swc, or a plain `next dev` "Module not found" crash from `@clerk/clerk-react`. Fix: `rm -rf node_modules/<package> && npm install <package> --no-save` re-extracts a single package — but fixing packages one at a time can keep surfacing a *new* broken package on each subsequent command, since `typecheck` → `lint`/`test` → `next dev` each exercises a different subset of the dependency graph and earlier gates don't catch what a later one needs. **Past ~2 individually-fixed packages in one session, stop whack-a-moling and escalate to a full reset:** `rm -rf node_modules` in the repo root *and* every workspace under `apps/*`, `packages/*`, `tools/*`, then `npm ci` from the repo root. CI runs Node 20 on Linux and is unaffected. Original investigation: [#373](https://github.com/merickvaughn/lifting-logbook/issues/373); broadened failure-shape catalog and escalation guidance: [#721](https://github.com/merickvaughn/lifting-logbook/issues/721).
  - **Node 24 Jest worker OOM (Windows only):** Several `packages/core` CSV-fixture-heavy suites exhaust per-worker heap when run in parallel on Node 24. Codified workaround: `jest.config.base.js` applies `workerIdleMemoryLimit: '512MB'` + `maxWorkers: '50%'` when `process.platform === 'win32'`. Linux Node 20 CI is unaffected by both the failure and the setting. Investigation: [#419](https://github.com/merickvaughn/lifting-logbook/issues/419).
  - **Windows full-suite parallel-load flakes (local only):** Under a full `npm test` (`turbo run test` runs several jest processes concurrently), Windows oversubscribes the CPU and produces isolation-only flakes — the api `*.db.e2e.spec.ts` `beforeAll` hooks (DB connect + seed + Nest bootstrap) trip Jest's 5s default hook timeout, and a slow web suite occasionally reports `1 failed`. Codified workaround: the two `apps/api/src/**/*.db.e2e.spec.ts` suites pass an explicit 30s `beforeAll` timeout (`DB_E2E_HOOK_TIMEOUT_MS`; apps/api's jest config is standalone and does not extend the win32-capped base), and `jest.config.base.js` adds `testTimeout: 15000` on win32 for the base-extending workspaces (web/core/types/api-client). Linux CI keeps the 5s default. Investigation: [#567](https://github.com/merickvaughn/lifting-logbook/issues/567).
  - **Windows web-suite worker OOM (local only):** A full `npm test -w @lifting-logbook/web` parallel run on Windows can OOM a Jest worker at load — most visibly the CSV-heavy onboarding suites (`StepImport`/`StepLifts`), which pull jsdom + React + the full `@lifting-logbook/core` barrel into every worker; every test that *runs* passes and the suites pass cleanly in isolation (`npx jest --config apps/web/jest.config.js --runInBand "StepImport.test|StepLifts.test"`). The [#419](https://github.com/merickvaughn/lifting-logbook/issues/419) `workerIdleMemoryLimit`/`maxWorkers` mitigation lives in `jest.config.base.js` but is gated to Node ≥ 24, so on Node 20 the web project had no memory guard (only the [#567](https://github.com/merickvaughn/lifting-logbook/issues/567) `testTimeout`). Codified workaround: `apps/web/jest.config.js` re-applies `workerIdleMemoryLimit: '512MB'` + `maxWorkers: '50%'` on *every* win32 Node (independent of the base's Node-24 gate), since web's per-worker footprint is heavier than `packages/core`'s. Linux CI is unaffected (not win32). Investigation: [#807](https://github.com/merickvaughn/lifting-logbook/issues/807).
  - **Windows api-suite worker OOM (local only):** A full `npm test -w @lifting-logbook/api` parallel run on Windows can OOM a Jest worker at load — most visibly `programs.e2e.spec.ts` and `programs.db.e2e.spec.ts` (1700+ / 1400+ lines each, both bootstrap a full NestJS + Fastify app), which crash with "Jest worker ran out of memory" while every other suite, and both files run in isolation, pass cleanly. `apps/api`'s jest config is standalone and does not extend `jest.config.base.js` (see the "Windows full-suite parallel-load flakes" bullet above), so it had no memory guard at all until now. Codified workaround: `apps/api/jest.config.js` applies the same `workerIdleMemoryLimit: '512MB'` + `maxWorkers: '50%'` pair directly, for every win32 Node. Linux CI is unaffected (not win32). Found while adding DB-e2e coverage for [#904](https://github.com/merickvaughn/lifting-logbook/issues/904); fixed in [PR #907](https://github.com/merickvaughn/lifting-logbook/pull/907).
- **Package manager:** npm (workspaces)
- **`jq` is NOT available.** Use `node -e` with a temp file in the working directory for JSON parsing:
  ```bash
  TMPFILE="tmp_$$.json"
  some-command --format json > "$TMPFILE"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$TMPFILE','utf8'));
    console.log('VAR=' + d.field);
  "
  rm -f "$TMPFILE"
  ```
- **Never use `/tmp/`** for temp files — Node.js on Windows cannot resolve Git Bash Unix paths. Write temp files to the working directory instead.
- **`gh` CLI** is available and authenticated. The `project` scope must be added separately when needed: `gh auth refresh -s project`.
- **Prefer Git Bash** over PowerShell for scripting — PowerShell handles arrays and arithmetic differently and has caused failures in this environment.

### Tooling constraints

- **Turborepo 2.x requires a `packageManager` field in the root `package.json`.** Without it, `turbo run *` fails with `Could not resolve workspaces. Missing packageManager field in package.json`. Always ensure `packageManager` is set when scaffolding a new monorepo root or upgrading Turborepo.
- **ESLint 9 uses flat config (`eslint.config.js`), not `.eslintrc.js`.** ESLint 9 dropped `.eslintrc*` support by default, so creating an `.eslintrc.js` silently does nothing. When an issue or acceptance criterion references `.eslintrc.js`, create `eslint.config.js` instead and note the translation in the PR description. Use `@typescript-eslint/eslint-plugin`'s `flat/recommended` config — it is an array of three objects (entry 0 registers the plugin and sets the parser via `languageOptions`), so spread the whole array rather than configuring the parser separately. To fall back to the legacy config format, set `ESLINT_USE_FLAT_CONFIG=false`. Validated in PR #24.

---

## Repository Layout

Turborepo monorepo with npm workspaces:

```
packages/core        — pure domain logic (no infrastructure dependencies)
packages/types       — shared TypeScript interfaces and API contracts
packages/api-client  — typed REST client with pluggable auth (shared by web server + browser)
apps/api             — NestJS + Fastify (primary): REST + GraphQL
apps/web             — Next.js App Router frontend
apps/mobile          — React Native (Expo) mobile client
infra/kubernetes/    — GKE Autopilot manifests and Helm charts
infra/cloud-run/     — Cloud Run service YAML
infra/terraform/     — Shared infrastructure: VPC, load balancer, DNS, IAM
docs/adr/            — Architecture Decision Records (see docs/README.md for the full ADR index)
docs/README.md       — Full architecture narrative and ADR index
scripts/             — Repository automation scripts
```

Architecture follows hexagonal / Ports & Adapters. `packages/core` has zero infrastructure dependencies. See [`docs/README.md`](docs/README.md) for full context.

---

## GitHub Project & Epic Assignment

All new issues must be added to the **Lifting Logbook** project and assigned an epic before work begins.

**Board-item lookups resolve the issue's project-item ID directly via GraphQL — they never enumerate the board, so they never truncate.** See the `gh api graphql … issue(number:$number){projectItems…}` calls in Standard Issue Workflow steps 3 and 9. Do **not** replace them with `gh project item-list --limit N` + a client-side `.find()`: that pages the entire board and silently returns `undefined` for any issue past the page limit (the project passed 500 items on 2026-07-17, so `--limit 500` could not see issue #837+). Prior `--limit` bumps (300→500→1000; [#601](https://github.com/merickvaughn/lifting-logbook/issues/601), [#632](https://github.com/merickvaughn/lifting-logbook/issues/632)) were a treadmill this approach ends ([#852](https://github.com/merickvaughn/lifting-logbook/issues/852)).

**Project IDs (needed for CLI commands):**
- Project number: `2`, owner: `merickvaughn`
- Project node ID: `PVT_kwDOEecHO84BeFl_`
- Epic field ID: `PVTSSF_lADOEecHO84BeFl_zhYiZmg`

**Epic options:**

| Name | Option ID |
|---|---|
| Monorepo Scaffolding | `b36a539f` |
| Package & App Scaffolding | `5f7ee7e1` |
| Port Interfaces | `679c2b39` |
| Shared Types | `cd1dd755` |
| CI/CD Foundation | `8e936837` |
| Architecture & Documentation | `2f5e3e1b` |
| Observability | `3b3b9b8c` |
| API Implementation | `df8223db` |
| Client Applications | `5111fafe` |
| Operations | `de6caeb7` |

> **IDs regenerate on every option mutation.** `updateProjectV2Field` with `singleSelectOptions` is a full replacement — passing the existing options unchanged still produces new IDs and drops every item's prior assignment. Always follow the **Backup-and-restore procedure** below before any mutation, and update this table — **plus the other two ID caches listed in step 3** — immediately after.

**Backup-and-restore procedure (mandatory before adding/removing/renaming any single-select option):**

1. Snapshot current single-select assignments (Epic, Status, Priority) to a git-tracked file. The
   query **paginates through every item** — `items(first: 100)` alone caps the snapshot at 100 items
   and silently drops the rest ([#857](https://github.com/merickvaughn/lifting-logbook/issues/857): the
   board passed 500 items on 2026-07-17), so a restore would lose the un-captured items' assignments.
   `gh api graphql --paginate` loops on `pageInfo`/`endCursor` automatically (no fixed `--limit` to
   keep bumping — the treadmill [#852](https://github.com/merickvaughn/lifting-logbook/issues/852) warns
   against), and the completeness guard refuses to commit an incomplete snapshot:
   ```bash
   mkdir -p .claude/backups
   STAMP=$(date +%Y-%m-%d-%H%M%S)
   SNAP=".claude/backups/project-epic-snapshot-$STAMP.json"
   # One line-delimited JSON object per item: id, issue number/title, and every single-select
   # field value (Epic, Status, Priority, …) so restore works whichever field is later mutated.
   gh api graphql --paginate -f query='
     query($endCursor: String) {
       node(id: "PVT_kwDOEecHO84BeFl_") { ... on ProjectV2 {
         items(first: 100, after: $endCursor) {
           pageInfo { hasNextPage endCursor }
           nodes { id content { ... on Issue { number title } }
             fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue {
               name field { ... on ProjectV2SingleSelectField { name } } } } } } } } } }' \
     --jq '.data.node.items.nodes[] | {id, number: .content.number, title: .content.title,
       fields: [.fieldValues.nodes[] | select(.name) | {field: .field.name, value: .name}]}' \
     > "$SNAP"
   # Completeness check (#857): snapshot line count must equal the live project item count, or the
   # snapshot truncated — do NOT run the mutation until the mismatch is understood.
   SNAP_ITEMS=$(wc -l < "$SNAP")
   LIVE_ITEMS=$(gh api graphql -f query='query { node(id: "PVT_kwDOEecHO84BeFl_") { ... on ProjectV2 { items { totalCount } } } }' --jq '.data.node.items.totalCount')
   echo "snapshot: $SNAP_ITEMS items   live: $LIVE_ITEMS items"
   if [ "$SNAP_ITEMS" -eq "$LIVE_ITEMS" ]; then
     git add "$SNAP"
     git commit -m "[chore] Snapshot project Epic assignments before option mutation"
   else
     echo "ERROR: snapshot incomplete ($SNAP_ITEMS of $LIVE_ITEMS captured) — do NOT proceed; investigate."
   fi
   ```
2. Run the `updateProjectV2Field` mutation with the full desired option list (existing names + new/changed).
3. Capture the new option IDs from the mutation response and update **all three places these IDs are cached**, in the same PR as the snapshot — all must match the live API:
   - the **Epic options** table above;
   - [`.claude/propose.json`](.claude/propose.json) — the `epics` array (consumed by `/propose`);
   - [`.claude/hook-config.json`](.claude/hook-config.json) — the `epic_options` map (consumed by the `post-tool-use.py` project-board hook, which prints them verbatim with no live fetch).

   > `hook-config.json` was the cache omitted in the 2026-05-10 mutation, which left the issue/PR hook suggesting dead Epic option IDs until [#627](https://github.com/merickvaughn/lifting-logbook/issues/627). Do not skip it.

   Then confirm the three caches actually agree, before committing:
   ```bash
   node scripts/check-board-id-sync.mjs
   ```
   It cross-checks the project node ID, the Epic/Status field IDs, all 10 Epic option IDs, the owner,
   the project number, the Done option ID and the milestone titles across the three files — and catches a partial hand-edit
   *within* CLAUDE.md, where the node ID alone appears six times. Note it is a **drift** check, not a
   **liveness** check: it proves the three caches agree with each other, not that they match the live
   API — that part is still on you, per this step's opening line. It also runs in CI, so a partial
   refresh fails the PR ([#865](https://github.com/merickvaughn/lifting-logbook/issues/865)).
4. Restore assignments by reading the snapshot (one JSON object per line) and re-issuing `gh project item-edit` for each item: for each line, take the `fields[]` entry whose `field` is the mutated field (e.g. `Epic`), map its `value` (the option name) → the new option ID, and edit the item by its `id`.

If a mutation runs without a prior snapshot commit, stop and recover from the latest snapshot in `.claude/backups/` before continuing any other work.

> **Milestones drift the same way, via a different trigger.** Milestones aren't a ProjectV2 single-select field, so a new milestone isn't created by the `updateProjectV2Field` mutation above — but the table below and the `milestones` arrays in `.claude/hook-config.json` and `.claude/propose.json` are just as easy to leave stale when a new milestone is created via `gh api repos/.../milestones` or the web UI. Update all three in the same PR that adds a milestone. `scripts/check-board-id-sync.mjs` compares the milestone **titles** across all three and fails CI if they diverge (the numbers live only in the table below, so they are not cross-checkable).

**Milestones:**

| Title | Number |
|---|---|
| v0.1 — Foundation | `1` |
| v0.2 — Core API | `2` |
| v0.3 — Client Applications | `3` |
| v0.4 — Alpha Release | `4` |

**Workflow — run after `gh issue create`:**

```bash
# Requires project scope — add once if needed: gh auth refresh -s project

# 1. Set milestone (use the milestone title)
gh issue edit <N> --milestone "<milestone-title>"

# 2. Add issue to project, capture item ID
TMPFILE="tmp_$$.json"
gh project item-add 2 --owner merickvaughn --url <issue-url> --format json > "$TMPFILE"
ITEM_ID=$(node -e "const d=JSON.parse(require('fs').readFileSync('$TMPFILE','utf8')); console.log(d.id);")
rm -f "$TMPFILE"

# 3. Set Epic field
gh project item-edit --project-id PVT_kwDOEecHO84BeFl_ --id "$ITEM_ID" \
  --field-id PVTSSF_lADOEecHO84BeFl_zhYiZmg \
  --single-select-option-id <option-id>
```

If `--format json` is not supported by the installed `gh` version, fall back to the GraphQL API via `gh api graphql`.

---

## Standard Issue Workflow

> **Prerequisite:** ensure the issue is already in the Lifting Logbook project with an Epic set (see above).

1. Read the issue body and acceptance criteria: `gh issue view <N>`
2. Create a branch: `git checkout -b <type>/issue-<N>-<slug>` (see Branch Naming)
3. Move the issue to **In Progress** on the project board:
   ```bash
   # Resolve this issue's project-item ID directly — no board enumeration, so it never truncates (#852)
   ITEM_ID=$(gh api graphql -f query='query($number:Int!){repository(owner:"merickvaughn",name:"lifting-logbook"){issue(number:$number){projectItems(first:10){nodes{id project{number}}}}}}' -F number=<N> --jq '.data.repository.issue.projectItems.nodes[]|select(.project.number==2)|.id')
   gh project item-edit --project-id PVT_kwDOEecHO84BeFl_ --id "$ITEM_ID" \
     --field-id PVTSSF_lADOEecHO84BeFl_zhYiZk8 \
     --single-select-option-id a5322fc5
   ```
4. Implement the changes
5. Commit with `Closes #<N>` in the message (see Commit Format)
6. Push: `git push -u origin <branch>`
7. Open a PR: `gh pr create --title "<prefix> <title>" --body "..."`
8. After PR approval, merge with a single command. `main` has required a GitHub **merge queue**
   since [#695](https://github.com/merickvaughn/lifting-logbook/issues/695), so this doesn't merge
   the PR directly. Per `gh pr merge --help`, targeting a merge-queue branch needs no strategy flag
   at all: if required checks haven't finished, the call enables auto-merge; once they pass, the PR
   is added to the queue, which performs the actual squash merge (confirmed live on
   [PR #879](https://github.com/merickvaughn/lifting-logbook/pull/879), 2026-08-01). `--squash` is
   still accepted and still describes the eventual merge method, so keep passing it:
   ```bash
   gh pr merge <N> --squash
   ```
   Don't expect the PR to be merged the instant the command returns — see "Merge enqueues instead of
   landing" under Testing for how to check queue position/state, and the `--admin` flag for an
   emergency bypass. Branch deletion is unaffected either way: the repo has `delete_branch_on_merge`
   enabled ([#841](https://github.com/merickvaughn/lifting-logbook/issues/841); verify live with
   `gh api repos/merickvaughn/lifting-logbook --jq .delete_branch_on_merge` → `true`), so GitHub
   deletes the remote branch server-side the instant the merge lands, queued or direct. Do **not** add
   `--delete-branch` or a manual `gh api -X DELETE .../git/refs/heads/<branch>` — the ref is already
   gone by then, so an explicit delete now 422s. Omitting `--delete-branch` also retires the
   worktree-squatting-`main` failure class: without it, the merge does no local checkout, so a
   worktree holding `main` can no longer abort it. Any open PRs stacked on (based on) the merged
   branch are auto-retargeted to `main` by GitHub when the branch is deleted.
9. Move the issue to **Done** on the project board:
   ```bash
   # Resolve this issue's project-item ID directly — no board enumeration, so it never truncates (#852)
   ITEM_ID=$(gh api graphql -f query='query($number:Int!){repository(owner:"merickvaughn",name:"lifting-logbook"){issue(number:$number){projectItems(first:10){nodes{id project{number}}}}}}' -F number=<N> --jq '.data.repository.issue.projectItems.nodes[]|select(.project.number==2)|.id')
   gh project item-edit --project-id PVT_kwDOEecHO84BeFl_ --id "$ITEM_ID" \
     --field-id PVTSSF_lADOEecHO84BeFl_zhYiZk8 \
     --single-select-option-id 0112fb7c
   ```
10. Pull main: `git checkout main && git pull`
11. Close the issue if not auto-closed: `gh issue close <N>`
12. Update journals and tracking:
    - **Project journal** (`sessions/lifting-logbook/`): write or update this session's **stub** per the global journal workflow (see [Engineering Journal](#engineering-journal)) — PR merged, decisions made
    - **Meta journal** (`sessions/meta/`): update if `CLAUDE.md` was modified or a new platform constraint was discovered
    - **ROADMAP.md**: if this PR completes a work stream listed in a milestone's Active Work table, move that row to the milestone's Shipped table; if the Active Work table becomes empty, replace it with `| *(all shipped)* | | |`
    - **Proposal Status**: if this PR ships, accepts, or declines a proposal, update the `**Status:**` field in the matching `docs/proposals/*.md` file **and** its ROADMAP.md Proposals-table row in the same PR, so the proposal file and the roadmap never diverge
13. Write the stub's `<!-- next-session-context -->` block and display it as the closing output of the session

### REST-endpoint fallback when the shared GraphQL rate limit is exhausted

The `gh pr *` commands the steps above depend on — `gh pr create` (step 7), `gh pr merge`
(step 8), `gh pr view --json`, `gh pr comment` — are **all GraphQL** calls, and this repo's 60+
concurrent worktrees share **one GitHub API rate-limit bucket per resource class**. GraphQL can
therefore exhaust while the separate **REST (core)** bucket is still healthy. Motivating incident:
[PR #700](https://github.com/merickvaughn/lifting-logbook/pull/700)'s session (2026-07-05) — `gh pr
create` died with `GraphQL: API rate limit already exceeded` while REST core showed 4999/5000. The
buckets are independent, so when a `gh pr` command fails that way, don't wait for the reset — fall
back to the REST equivalents. (The global
[`CLAUDE.md`](https://github.com/brownm09/dev-env/blob/main/claude/CLAUDE.md) documents the rate-limit
*hazard*; the steps below are the *mitigation*.)

- **Compare both buckets first** — REST usually still has budget:
  ```bash
  gh api rate_limit
  # resources.graphql = gh pr create / merge / view --json / comment
  # resources.core    = the gh api REST calls below
  ```
- **Create a PR** instead of `gh pr create` — write the body to a scratch file first so backticks
  aren't mangled by the shell:
  ```bash
  gh api -X POST repos/merickvaughn/lifting-logbook/pulls \
    -f title="[docs] ..." -f head="<branch>" -f base=main \
    -F body=@C:/Users/brown/.claude/scratch/pr-body.md
  ```
- **Merge.** `gh pr merge <N> --auto --squash` is a single lightweight GraphQL call that arms GitHub
  to squash-merge once checks pass — prefer it while GraphQL has *any* budget. If GraphQL is fully
  exhausted, merge over REST — GitHub still deletes the branch server-side, since
  `delete_branch_on_merge` is enabled, so there is no explicit ref-delete (it would 422):
  ```bash
  gh api -X PUT repos/merickvaughn/lifting-logbook/pulls/<N>/merge -f merge_method=squash
  ```
- **Inspect PR state** instead of `gh pr view --json`:
  ```bash
  gh api repos/merickvaughn/lifting-logbook/pulls/<N>
  ```

---

## Branch Naming

| Issue type | Pattern | Example |
|---|---|---|
| chore / scaffold | `chore/issue-<N>-<slug>` | `chore/issue-2-root-tooling` |
| feature | `feat/issue-<N>-<slug>` | `feat/issue-5-core-migration` |
| infrastructure | `infra/issue-<N>-<slug>` | `infra/issue-16-ci-pipeline` |
| documentation | `docs/issue-<N>-<slug>` | `docs/issue-15-shared-types` |
| bug fix | `fix/issue-<N>-<slug>` | `fix/issue-22-auth-token-expiry` |

---

## Commit Message Format

```
[<type>] <imperative-mood description>

<body — optional, for non-obvious decisions or multi-part changes>

Closes #<N>
```

**Types:** `chore`, `feat`, `fix`, `docs`, `infra`, `test`, `refactor`

**Example:**
```
[chore] Initialize Turborepo monorepo with workspace structure

Converts root package.json to private workspaces, adds turbo.json pipeline,
and creates directory skeleton with .gitkeep placeholders.

Closes #1
```

---

## PR Conventions

- **Title format:** `[<type>] <description>` (matching the commit type prefix)
- **Body:** Summary paragraph + Acceptance Criteria checklist (copy from issue) + test instructions
- **Merge strategy:** Squash merge only — keeps `main` history linear
- **Branch cleanup:** Automatic — `delete_branch_on_merge` is enabled ([#841](https://github.com/merickvaughn/lifting-logbook/issues/841)), so GitHub deletes the remote branch server-side on merge. Don't pass `--delete-branch` or run a manual `gh api -X DELETE .../git/refs/heads/<branch>` (it would 422); just `gh pr merge <N> --squash` per Standard Issue Workflow step 8. Any PRs stacked on the merged branch are auto-retargeted to `main`.

---

## Files to Never Read

These files are large and never need to be read directly:

- `package-lock.json` — 8,000+ lines; commit it without reading it
- `node_modules/**` — never relevant
- `.turbo/**` — build cache, never relevant

---

## Worktree Setup

Claude Code creates git worktrees under `.claude/worktrees/` when running tasks in isolation.
A new worktree has its own directory but **does not inherit a working `node_modules`** from the
main repo. Before the first commit in a worktree, always run:

```bash
npm install
```

**Why this is required:**

- The pre-commit hook (`npx turbo run lint`) needs `turbo`, which is a native binary downloaded
  during the `postinstall` script. Without `npm install`, the hook fails with
  `Error: spawnSync ... EUNKNOWN` or `%1 is not a valid Win32 application`.
- On Windows, worktrees under paths containing `.claude` cannot spawn the native `turbo.exe`
  from that path. `.husky/pre-commit` works around this by setting `TURBO_BINARY_PATH` to
  the main repo root's turbo binary — but this only works if `npm install` has been run in the
  worktree first, so that `npx turbo` resolves correctly. See [ADR-022](docs/adr/ADR-022-monorepo-docker-build-strategy.md) for broader context on why the toolchain is sensitive to install state.

**Symptom if skipped:** `Lint failed. Commit aborted.` or a Node.js `EUNKNOWN` crash on the first
`git commit`.

**Recovery after a failed `npm ci` (EUSAGE) + `npm install`:** when a lockfile-drift `npm ci`
fails mid-install and you recover with `npm install`, the worktree-local `node_modules/turbo` can
be left **missing or incomplete** — the test suite may have kept running via the *global* `turbo`,
masking the gap. The next `git commit` then fails the `.husky/pre-commit` lint hook with
`Lint failed. Commit aborted.` **even though `npx turbo run lint` passes standalone** (the hook
requires the worktree-local `turbo` via `TURBO_BINARY_PATH`, not the global one). The fix is a
clean **`npm ci`** once the lockfile is back in sync — *not* another `npm install`, which can
leave the same partial-extract state. Motivating incident: the #570/#571 session (Windows, Node 20).

---

## CLI Scripting Checklist

Before writing a `gh` or other CLI automation script:

1. Run `<command> --help` first to confirm flag names and syntax
2. Confirm which JSON tools are available (`jq` is NOT available — use `node -e`)
3. Confirm temp file location (`C:/Users/brown/.claude/scratch/`, not `/tmp/` or a project repo directory)
4. Check whether any additional `gh` auth scopes are needed

---

## Proposals and Roadmap

### /propose workflow

Run `/propose <one-line idea>` from the repo root to introduce a new feature or change.
The skill handles the full flow: clarifying questions → proposal doc → GitHub issue → ROADMAP entry → PR.

Do not create `docs/proposals/` files or ROADMAP entries manually unless `/propose` is
unavailable. The skill ensures the issue, epic, and milestone are assigned consistently.

### docs/proposals/ convention

- Files live at `docs/proposals/YYYY-MM-DD-<slug>.md`
- The master template is at `dev-env/claude/templates/proposal.md` — do not duplicate it here
- Statuses: `draft` → `accepted` → `shipped` | `declined`
- Update the `**Status:**` field in the proposal file when status changes
- Update the linked issue's milestone or labels to match if scope changes

### ROADMAP.md maintenance

- `ROADMAP.md` at the repo root is the editorial view; it is **not** a GitHub mirror
- `/propose` appends rows to the correct milestone's **Proposals** table automatically
- Update the **Active Work** tables manually when: an item starts, completes, or moves milestones
- Material milestone-scope changes (dropping or moving items) require a PR with an explicit
  explanation — same bar as material changes to `docs/PRD.md`

---

## Coding Standards

App-level coding standards are in `docs/standards/`. Each file is a self-contained rule with
rationale, examples, and enforcement notes. Existing standards:

| File | Applies to | Rule |
|---|---|---|
| [`docs/standards/fetch-cache-semantics.md`](docs/standards/fetch-cache-semantics.md) | `apps/web` Server Components | All `fetch()` calls must specify `{ cache: 'no-store' }` or `{ next: { revalidate: N } }` explicitly |
| [`docs/standards/error-fallback-test-coverage.md`](docs/standards/error-fallback-test-coverage.md) | all packages and apps | Error-swallowing fallbacks (`.catch(() => default)`, `?? default`, try/catch returning neutral) require a data-level assertion, a paired success-path test, or a documented structure-only comment |
| [`docs/standards/training-max-precision.md`](docs/standards/training-max-precision.md) | all packages and apps | Directly-known training-max weights are never rounded; formula-derived estimates floor to the nearest plate increment; computed per-workout weights round to the nearest *loadable* plate combination |

When implementing `apps/web`, read the relevant standards before writing any `fetch()` calls.

---

## Testing

Run `npm test` from the repo root to execute the full test suite across all workspaces.

```bash
npm test
```

Type-checking runs as a separate Turbo task. ts-jest runs **transpile-only** for speed (see
[#651](https://github.com/merickvaughn/lifting-logbook/issues/651)), so a dedicated `tsc --noEmit` gate
owns type-checking for `core` and `web`. It is a **blocking CI gate** (CI runs
`turbo run lint typecheck test`) — run it before opening a PR:

```bash
npm run typecheck
```

**Prerequisites:**
- Run `npm run build` first if you have touched compiled output (e.g., API controllers, shared types in `packages/types`).
- The API DB E2E suite (`apps/api/src/programs/programs.db.e2e.spec.ts`) auto-provisions Postgres via Testcontainers in `apps/api/jest.global-setup.js`. Docker Desktop must be running; no `DATABASE_URL` configuration is required locally. In CI, the existing service container provides `DATABASE_URL` and globalSetup uses it directly.
- **When Docker is down:** globalSetup hard-fails with a multi-line actionable message naming three recovery options (fix Docker, use `docker-compose.test.yml`, or set `LIFTING_SKIP_DB_E2E=1`). The escape hatch is only valid when the diff under test touches no DB code (no changes under `apps/api/prisma/`, no repository changes); cite [issue #394](https://github.com/merickvaughn/lifting-logbook/issues/394) in the PR body when it is used. See [`docs/testing/e2e-coverage.md`](docs/testing/e2e-coverage.md) for the full recovery procedure.

Individual workspaces can be verified independently:

```bash
npm test -w @lifting-logbook/core
npm test -w @lifting-logbook/api
npm test -w @lifting-logbook/web
```

### apps/web Playwright E2E (local)

`apps/web` has two test layers. `npm test -w @lifting-logbook/web` runs Jest unit/component tests only. A separate Playwright suite lives in `apps/web/e2e/` and runs in CI's "Playwright E2E" job — it does **not** run as part of `npm test`.

**Run it locally before pushing whenever a change touches `apps/web` and any of the following:**

- UI display strings (headings, button labels, link text)
- `aria-label` values on inputs or regions
- Role names, tab labels, dialog titles
- Any string a Playwright `getByLabel` / `getByRole` / `locator('text=...')` call might match

```bash
# From the repo root — playwright.config.ts auto-starts mock-api + next dev on per-run dynamic ports (#746)
npm run test:e2e -w @lifting-logbook/web
```

Playwright browsers must be installed once (`npx playwright install chromium`; CI uses the `--with-deps` form for its Linux runner — that flag is a no-op on Windows). The config handles all env vars (dummy Clerk keys, `DEV_AUTH_TOKEN`, `API_URL`) so no manual setup is needed. The motivating incident is [#444](https://github.com/merickvaughn/lifting-logbook/issues/444) / PR #438, where an aria-label rename (`Back Squat` → `Squat`) passed Jest but broke the smoke spec and was only caught by CI.

**Heavy on-demand-compiled routes need a `beforeAll` warmup.** When a Playwright e2e spec targets a heavy App Router route that Next dev compiles on-demand (e.g. `/import`), the first cold compile on Windows local dev can exceed Playwright's default `expect` (5s) *and* per-test (30s) timeouts — the first `page.goto` dies before any assertion runs. Warm the route once in a `test.beforeAll` that navigates a throwaway page to it with generous headroom (`test.setTimeout(120_000)` plus a ~90s `goto`/`expect` timeout), so every test then runs against an already-compiled route; CI (Linux) compiles fast enough that the warmup is a no-op there. Reference implementation: [`apps/web/e2e/import.spec.ts`](apps/web/e2e/import.spec.ts); motivating incident [#698](https://github.com/merickvaughn/lifting-logbook/issues/698) / [PR #715](https://github.com/merickvaughn/lifting-logbook/pull/715).

**Troubleshooting — `ECONNREFUSED` on Windows (all e2e tests fail at once).** If every test fails with `apiRequestContext.get: connect ECONNREFUSED` (on `::1:3004` *or* `127.0.0.1:3004`) and `page.goto` hangs until it times out, the cause is an IPv4/IPv6 loopback mismatch, not a UI-string regression. On Windows the `webServer` processes (`node e2e/mock-api.mjs` on :3004, `next dev` on :3000) bind loopback **non-deterministically** — the default `server.listen(port)` / `next dev` host can come up IPv4-only *or* `::1`-only across runs — while Node 18+'s `verbatim` DNS resolves `localhost` to `::1` first. So a client dialing one family can reach a server listening on the other and get refused. The harness pins **everything** to `127.0.0.1` (unambiguous IPv4 loopback on every platform) so client, server bind, and readiness probe always agree: Playwright `use.baseURL`, the webServer `API_URL` / `PUBLIC_API_URL` env, `next dev --hostname 127.0.0.1`, the `url:` readiness probes (not bare `port:`) — all in [`apps/web/playwright.config.ts`](apps/web/playwright.config.ts) — plus the mock's `server.listen(PORT, '127.0.0.1')` bind in [`apps/web/e2e/mock-api.mjs`](apps/web/e2e/mock-api.mjs) and the `MOCK_API` constant in each spec. Linux CI is unaffected (`localhost` and `127.0.0.1` both resolve to IPv4 loopback there), so **keep these on `127.0.0.1`, never `localhost`** — reverting any one of them reintroduces the Windows failure. Because `reuseExistingServer` is on locally, a leftover/zombie server from a prior run could once be silently reused across worktrees; [#746](https://github.com/merickvaughn/lifting-logbook/issues/746) fixed that structurally — `playwright.config.ts` now allocates a **free port per run** (`allocatePorts()`) for both the mock and `next dev`, threading it through `MOCK_API_PORT` / `PLAYWRIGHT_MOCK_API_URL` and `use.baseURL`, so concurrent worktrees each start their own servers and never share. A stale server squatting this run's freshly-allocated port is astronomically unlikely and would surface as a startup `EADDRINUSE`, not a silent wrong-build reuse. Motivating incidents: [#741](https://github.com/merickvaughn/lifting-logbook/issues/741) (127.0.0.1 host pinning), [#746](https://github.com/merickvaughn/lifting-logbook/issues/746) (per-worktree dynamic ports).

### Turbo version pin sync (Dockerfile ↔ package.json)

`apps/web/Dockerfile`'s installer stage pins `npx turbo@<version> prune` to an exact version — `node_modules` is dockerignored ahead of that step, so a bare `npx turbo` has no local install to prefer and would fetch whatever the registry currently tags `latest`. That pin must match the root `package.json`'s `devDependencies.turbo` exactly, or the prune step and the later `npm ci`/build step in the same image run under two different turbo versions with nothing to catch the drift until an uncached Docker build. See [#674](https://github.com/merickvaughn/lifting-logbook/issues/674) / [#692](https://github.com/merickvaughn/lifting-logbook/issues/692).

**Run before pushing whenever `apps/web/Dockerfile` or the root `package.json`'s `turbo` devDependency changes:**

```bash
node scripts/check-turbo-version-sync.mjs
```

This also runs as a CI step (`ci.yml` → `lint-and-test` → "Verify turbo version pin sync"), so a drifting PR fails either way — running it locally just catches the mismatch before waiting on CI.

### Grafana OTLP/Loki endpoint single source

The Grafana Cloud OTLP/Loki ingest endpoints live in exactly one file — [`infra/observability/grafana-endpoints.env`](infra/observability/grafana-endpoints.env) — and every consumer derives them from it: `deploy.yml` sources it for the Cloud Run sidecar inject and passes it to the GKE `otel-collector` Helm chart via `--set-string`. This is the fix for the endpoint-drift class behind the no-telemetry incident [#781](https://github.com/merickvaughn/lifting-logbook/issues/781): a region/gateway change is now a one-line edit there, and re-hardcoding a literal endpoint anywhere else is a CI failure.

**Run before pushing whenever you change an OTLP/Loki endpoint or touch its wiring (`deploy.yml`, the `*-otel-collector.yaml` values files, or the Cloud Run collector config):**

```bash
node scripts/check-grafana-endpoint-sources.mjs
```

This also runs as a CI step (`ci.yml` → `lint-and-test` → "Verify Grafana OTLP/Loki endpoints have a single source"), so a drifting PR fails either way — running it locally just catches a re-hardcoded endpoint before waiting on CI. See [#785](https://github.com/merickvaughn/lifting-logbook/issues/785).

### otel-collector config sync (Cloud Run ↔ GKE)

The Cloud Run collector sidecar and the GKE DaemonSet must run the **same** pipeline (the premise of [#782](https://github.com/merickvaughn/lifting-logbook/pull/782)). The Cloud Run config [`infra/cloud-run/otel-collector-config.yaml`](infra/cloud-run/otel-collector-config.yaml) is kept identical — below its comment header — to the `config.yaml` block scalar embedded in the GKE [`infra/kubernetes/charts/otel-collector/templates/configmap.yaml`](infra/kubernetes/charts/otel-collector/templates/configmap.yaml). A guard fails CI if the two diverge, instead of relying on a "keep in sync" comment.

**Run before pushing whenever you edit either collector config (the Cloud Run file or the GKE configmap's `config.yaml` block):**

```bash
node scripts/check-otel-config-sync.mjs
```

This also runs as a CI step (`ci.yml` → `lint-and-test` → "Verify Cloud Run otel-collector config matches the GKE configmap"), so a drifting PR fails either way — running it locally just catches the divergence before waiting on CI. See [#788](https://github.com/merickvaughn/lifting-logbook/issues/788).

### Board-ID cache sync (CLAUDE.md ↔ `.claude/*.json`)

The GitHub Project board IDs are duplicated across three files because each has a separate consumer: the **Epic options** table and the `gh` snippets in this file, the `epics` array in [`.claude/propose.json`](.claude/propose.json) (read by `/propose`), and the `epic_options` map plus field IDs in [`.claude/hook-config.json`](.claude/hook-config.json) (read by the `post-tool-use.py` project-board hook). A single `updateProjectV2Field` mutation — or an org transfer — re-cuts the project node ID, the field IDs and every Epic option ID at once, so a **partial** refresh is the dangerous outcome: the board hook silently writes to a dead field, exactly as it did after the 2026-05-10 mutation ([#627](https://github.com/merickvaughn/lifting-logbook/issues/627)). A guard now fails CI on any divergence.

**Run before pushing whenever you touch a board ID in any of the three files — and always as step 3 of the Backup-and-restore procedure above:**

```bash
node scripts/check-board-id-sync.mjs
```

It compares the project node ID, the Epic/Status field IDs, all 10 Epic option IDs, the owner, the project number, the Done option ID and the milestone titles, and additionally verifies this file agrees with *itself* (the node ID alone appears six times, so a partial hand-edit is easy to make). It is a **drift** check, not a **liveness** check — three caches stale in lockstep pass by design; confirming they match the live API remains the manual step in the Backup-and-restore procedure. This also runs as a CI step (`ci.yml` → `lint-and-test` → "Verify board-ID caches are in sync (CLAUDE.md ↔ .claude/*.json)"), so a drifting PR fails either way. See [#865](https://github.com/merickvaughn/lifting-logbook/issues/865).

### Coverage Requirements

<!-- When #259 ships: remove the "until then" clause from the frontend row below. Tracked as a checklist item on issue #259. -->

| Change type | Required coverage |
|---|---|
| New API endpoint | In-memory E2E test in the same PR |
| New frontend page or interactive feature | Playwright test once #259 is implemented; until then, a written test plan in the PR body |
| `apps/web` UI string / aria-label / role-name change | Run `npm run test:e2e -w @lifting-logbook/web` locally before pushing (see above) |
| Bug fix | Regression test that fails before the fix and passes after |
| Refactor / docs only | None required — existing tests must pass |

**Blocking rule:** A PR that adds an API endpoint or frontend feature without satisfying the above is not mergeable.

### Failure-tracking rule

Every test failure reported in a pre-PR run must be resolved in one of two ways before `gh pr create`:

1. **Fixed in this PR** (default).
2. **Tracked by an open GitHub issue cited in the PR body** by number — prose explanation alone is not sufficient. If the failure does not yet have an issue, file one before opening the PR.

A label of "pre-existing" without an open-issue link is not acceptable. The motivating incident is [#349 / PR #355](https://github.com/merickvaughn/lifting-logbook/pull/355), where four API suite-load failures were carried as "pre-existing" until a one-line `postinstall` hook fixed the entire class — the rule should have forced the investigation up front. The global equivalent of this rule is tracked in [dev-env#281](https://github.com/brownm09/dev-env/issues/281).

### Skewed-test rule

When a PR adds or modifies a `.catch(() => default)`, `?? default`, or `try { … } catch { return neutral }` in a server component or API boundary, the test coverage for that code path must satisfy one of: (a) a data-level assertion the fallback would not produce, (b) a separate test that fails specifically when the upstream fails, or (c) an inline comment that names the swallowed-fallback source line and explains why structure-only is intentional. See [`docs/standards/error-fallback-test-coverage.md`](docs/standards/error-fallback-test-coverage.md) for the full rule and examples.

### Typecheck TS7016 on `react-dom/server` — incomplete install, not a code defect

**Pattern:** `npm run typecheck` fails on `apps/web` with:

```
error TS7016: Could not find a declaration file for module 'react-dom/server'.
'.../apps/web/node_modules/react-dom/server.node.js' implicitly has an 'any' type.
```

on the five `page.test.tsx` files that `import { renderToStaticMarkup } from 'react-dom/server'`.

**Root cause:** `react-dom@19`'s `package.json` `exports["./server"]` ships only runtime conditions (`node → server.node.js`, `browser`, `default`, …) and **no `types` condition**, so TypeScript cannot source the `react-dom/server` declaration from `react-dom` itself — it resolves the declaration solely from the **`@types/react-dom` devDependency** (whose `exports["./server"].types → server.d.ts`). `react-dom` is a runtime `dependency` while `@types/react-dom` is a `devDependency`, so any install that has deps but not devDeps — `npm install --omit=dev`, a partial/interrupted extract, or a worktree whose `npm install` never completed — leaves `react-dom` present but `@types/react-dom` absent → TS7016 on every `react-dom/server` import. It is **not** a version or `tsconfig` bug: a clean install (`npm ci` in CI, a fresh worktree `npm install`) always resolves it, and `@types/react-dom` resolves whether it sits in `apps/web/node_modules` or is hoisted to the repo-root `node_modules`.

**Symptom that confirms it:** the error names a `server.node.js` runtime file (so `react-dom` IS installed) rather than "Cannot find module" (which would mean `react-dom` itself is missing); the same five files pass under `npm ci` or a completed `npm install`.

**Fix:** run a full install in the worktree — `npm install`, or `rm -rf node_modules && npm ci` — then re-run `npm run typecheck`. As of [#777](https://github.com/merickvaughn/lifting-logbook/issues/777), `@types/react` + `@types/react-dom` are now also declared in the **root** `package.json` (`^19`), so they hoist to the repo-root `node_modules` and resolve from `apps/web` even when the workspace-local `devDependency` copy is torn — this **hardens but does not eliminate** the failure: an `--omit=dev` install still drops them everywhere, so the full-install recovery above remains the fix. (The hoist became possible once `apps/mobile` moved to Expo SDK 55 / RN 0.83 / React 19.2, aligning its `@types/react` onto the 19.2.x line so a single root-hoisted `@types/react` satisfies both apps; it previously `ERESOLVE`d against mobile's Expo 54 / RN 0.81 `@types/react@19.1.x` pin vs. `@types/react-dom`'s `@types/react@^19.2.0` peer.) Motivating incident: [#769](https://github.com/merickvaughn/lifting-logbook/issues/769).

### Jest silently ignores a mid-process `process.env.TZ` mutation on this repo's Windows setup

**Pattern:** A test that needs to exercise a genuinely different host timezone (e.g. "does this code correctly resolve a date on a host ahead of UTC") mutates `process.env.TZ` in a `beforeEach`/`beforeAll` and constructs `Date`/`Intl` objects afterward, on the commonly-cited assumption that Node respects `TZ` changes made at runtime. That assumption holds for a bare `node -e` script — it does **not** hold inside a Jest worker (`testEnvironment: 'node'`) on this repo's Windows/Node setup, where the identical mutation is a silent no-op: subsequently-constructed `Date` objects keep resolving local time against whatever timezone the process started with.

**Symptom:** A test asserting on `Date`-derived local-time fields (e.g. `new Date("12/16/2025").getUTCDate()`) doesn't change value across the `process.env.TZ` mutation, even though the identical mutation in a standalone `node -e` script works correctly. `Intl.DateTimeFormat().resolvedOptions().timeZone` confirms it directly — it stays pinned to the process's original timezone (e.g. `America/New_York`) after `process.env.TZ = 'Pacific/Auckland'` runs inside a test.

**Diagnosis:** Jest/V8 appears to cache host timezone data before test code executes, which is why a mid-test mutation never takes effect. A shell-level `TZ=X node ...` prefix (Git Bash) does **not** work around this on this Windows setup either — that's a separate MSYS environment-passthrough issue, not the same root cause as the Jest caching above, so ruling it out too is what confirms the mutation approach itself is the dead end, not a fixture or assertion bug.

**Fix:** Set `TZ` in the `env` option of a `child_process.spawnSync`/`execFileSync` call instead, launching a genuinely fresh child process — `TZ` set at process-launch time IS reliably respected. See [`packages/core/tests/core/utils/parser/dateParsing.aheadOfUtc.test.ts`](packages/core/tests/core/utils/parser/dateParsing.aheadOfUtc.test.ts) + [`packages/core/tests/support/aheadOfUtcChild.js`](packages/core/tests/support/aheadOfUtcChild.js) for the reference implementation: a single `beforeAll` spawns the child script once with `TZ=Pacific/Auckland` set in its environment, and assertions run against the real parser results it reports back over stdout.

Motivating incident: discovered while building the regression tests for [#894](https://github.com/merickvaughn/lifting-logbook/issues/894) (merged in [PR #900](https://github.com/merickvaughn/lifting-logbook/pull/900)) and extended for [#899](https://github.com/merickvaughn/lifting-logbook/issues/899) (merged in [PR #903](https://github.com/merickvaughn/lifting-logbook/pull/903)); documented in [#901](https://github.com/merickvaughn/lifting-logbook/issues/901).

### CI not firing — merge conflict silences GitHub Actions

**Pattern:** A PR in `CONFLICTING` (merge conflict) state causes GitHub Actions `pull_request` events to never fire. GitHub cannot create the virtual merge commit at `refs/pull/N/merge`, so the event is silently dropped — no checks are queued, no runs appear.

**Symptom:** `gh pr checks` returns "no checks reported" and `gh run list --branch <branch-name>` shows only stale runs from before the conflict.

**Diagnosis:**
```bash
gh pr view <N> --json mergeable,mergeStateStatus
# mergeable: "CONFLICTING" — direct conflict indicator; mergeStateStatus will also be "DIRTY"
```

**Fix:** `git fetch origin` first (the rebase target is only as current as this repo's local `origin/main` tracking ref — a stale ref means the rebase resolves against outdated content and doesn't actually clear the conflict against the real current `main`). Then rebase (or squash-rebase) the branch onto `origin/main` and force-push. Once the conflict is resolved, GitHub recreates the merge ref and CI fires normally on the next push.

Motivating incident: [PR #604](https://github.com/merickvaughn/lifting-logbook/pull/604).

### Stale-branch squash-merge rejection — update-branch API silently uses a stale main

**Pattern:** lifting-logbook has `allow_update_branch: false` in its repo settings (confirmed via `gh api repos/merickvaughn/lifting-logbook --jq .allow_update_branch`). When a PR's branch falls behind `main` and `gh pr merge --squash` is rejected with "the head branch is not up to date with the base branch", calling `gh api -X PUT repos/merickvaughn/lifting-logbook/pulls/<N>/update-branch` returns an apparent-success message (`{"message":"Updating pull request branch."}`) but the update can silently apply against a **stale snapshot** of `main` — not the current tip — with no error surfaced. In one observed case, the resulting merge commit's merged-in `main` SHA matched the PR's *original* base ref from when it was first opened, not `main`'s actual current HEAD, even though `main` had moved significantly since. `mergeStateStatus` stayed `BEHIND` for 9+ minutes with no indication anything was wrong.

**Symptom:** `mergeStateStatus` remains `BEHIND` well after `update-branch` reports success, and the eventual merge commit's second parent is not `main`'s actual current tip.

**Diagnosis:** After calling `update-branch`, check the resulting merge commit's second parent directly against `main`'s real tip:
```bash
gh pr view <N> --json headRefOid --jq .headRefOid   # PR branch tip after update-branch
git log -1 --format="%P" <merge-commit-sha>          # second hash is the merged-in main SHA
git rev-parse origin/main
```
If they don't match, the API used a stale snapshot.

**Fix:** Don't rely on the `update-branch` API for this repo. Instead, manually merge: create a worktree for the PR's branch, `git fetch origin` (the merge is only as current as this repo's local `origin/main` tracking ref), `git merge origin/main`, resolve any conflicts, `git push`. This is deterministic and uses the actual current `main` tip.

Motivating incident: [PR #722](https://github.com/merickvaughn/lifting-logbook/pull/722) merge session, 2026-07-08.

### Staging-deploy queue starvation — cross-PR mutex preemption

**Pattern:** `.github/workflows/staging.yml`'s `deploy-api`/`deploy-web` jobs serialize writes to the one shared staging Cloud Run service / Helm release via job-level concurrency groups (`staging-deploy-mutex-api`, `staging-deploy-mutex-web`, both `cancel-in-progress: false`). These groups are global, not per-PR. GitHub Actions keeps only the most-recently-queued run per concurrency group — when a third PR pushes while a second PR's deploy is already queued behind a first PR's running deploy, the second PR's queued run is silently cancelled and the third takes its place. Under sustained multi-PR throughput this can repeat for an unlucky PR across many cycles.

**Symptom:** The required `Staging Integration Tests` check fails with "Staging did not become ready in time" or an empty `WEB_URL`, even on a PR whose diff cannot plausibly affect staging (e.g. docs-only). The `deploy-api` or `deploy-web` job's own result shows `cancelled` rather than `failure`.

**Diagnosis:**
```bash
gh run list --workflow=staging.yml -R merickvaughn/lifting-logbook --limit 20
```
Open the cancelled run's job log — GitHub Actions annotates the cancellation directly: `Canceling since a higher priority waiting request for staging-deploy-mutex-web exists`.

**Fix:** Re-run once the queue has a lull:
```bash
gh run rerun <run-id> --failed
```
This is a known, already-diagnosed CI mechanic, not a new bug — see [#673](https://github.com/merickvaughn/lifting-logbook/issues/673) for the full root-cause analysis and [ADR-030](docs/adr/ADR-030-github-merge-queue-adoption.md) for the accepted structural fix (GitHub merge queue). The queue went live 2026-07-22 ([#695](https://github.com/merickvaughn/lifting-logbook/issues/695)) and now serializes PRs onto staging one at a time, so this starvation pattern shouldn't recur for queue-processed PRs (see "Merge enqueues instead of landing" below) — if it does, that's a regression, not the expected wait.

Motivating incidents: [PR #703](https://github.com/merickvaughn/lifting-logbook/pull/703), [PR #711](https://github.com/merickvaughn/lifting-logbook/pull/711).

### Merge enqueues instead of landing — GitHub merge queue on main

**What changed:** `main` has required a GitHub merge queue since
[#695](https://github.com/merickvaughn/lifting-logbook/issues/695) (live 2026-07-22; full decision
record in [ADR-030](docs/adr/ADR-030-github-merge-queue-adoption.md)). `gh pr merge <N> --squash`
(Standard Issue Workflow step 8) still succeeds, but per `gh pr merge --help` it no longer merges the
PR directly, and no strategy flag is actually required when targeting a merge-queue branch: if
required checks haven't finished, the call enables auto-merge; once they pass, the PR is added to the
queue, which performs the actual squash merge. This isn't a bug
([#880](https://github.com/merickvaughn/lifting-logbook/issues/880)), but a reader expecting an
immediate merge has no built-in signal that the PR is queued rather than merged. Confirmed live on
[PR #879](https://github.com/merickvaughn/lifting-logbook/pull/879) (2026-08-01):
```
$ gh pr merge 879 --squash
! The merge strategy for main is set by the merge queue
```
The PR was enqueued anyway — a bare re-run of `gh pr merge 879` afterward reported "already queued to
merge."

**Checking queue status:** neither `gh pr view --json` (merge-related fields are `autoMergeRequest`,
`mergeCommit`, `mergeStateStatus`, `mergeable`, `mergedAt`, `mergedBy`, `potentialMergeCommit` — no
queue-position field) nor `gh pr checks` shows queue state. GraphQL is the only reliable source. To
check whether a specific PR is queued and its position:
```bash
gh api graphql -f query='
query {
  repository(owner: "merickvaughn", name: "lifting-logbook") {
    mergeQueue(branch: "main") {
      entries(first: 10) {
        nodes {
          pullRequest { number }
          state
          position
        }
      }
    }
  }
}'
```
(an empty `nodes` array means nothing is currently queued for `main`). This answers a different
question than the `mergeQueue` config query in
[docs/operations/branch-protection.md](docs/operations/branch-protection.md#verifying-the-merge-queue-setting)
("Verifying the merge queue setting") — that one confirms the queue itself is configured correctly
(build concurrency, merge limits); this one confirms where a given PR sits in it.

**Emergency bypass:** `gh pr merge <N> --squash --admin` uses admin privileges to merge directly,
skipping the queue entirely (per `gh pr merge --help`, `--admin` also bypasses any other unmet merge
requirements) — requires admin access on the repo. Use sparingly: it defeats the queue's one-at-a-time
staging-validation guarantee (see ADR-030's Rationale section, linked above).

Motivating incident(s): [PR #879](https://github.com/merickvaughn/lifting-logbook/pull/879),
[#880](https://github.com/merickvaughn/lifting-logbook/issues/880).

### `autoMergeRequest: null` during a merge-queue hand-off is expected — not a third "silently cleared" bug

**Pattern:** Watching `gh pr view <N> --json autoMergeRequest` while a PR progresses through the
flow described in "Merge enqueues instead of landing" above can catch `autoMergeRequest` transition
from a populated object to `null`, with `mergeStateStatus` reading `UNSTABLE` at that instant — even
though no force-push happened and `gh pr checks <N>` shows every check `pass` (i.e. neither
"silently cleared" Pattern below applies). This is the PR completing its hand-off from "auto-merge
armed, waiting on the PR's own required checks" into "now being processed by the merge queue
itself," which re-validates against its own temporary merge commit — that hand-off appears to also
clear the standalone `autoMergeRequest` field, since the intent has been converted into an actual
queue entry.

**Diagnosis:** Run the `mergeQueue` GraphQL query from "Checking queue status" above *before*
assuming either "silently cleared" Pattern below applies. If the PR appears in `entries` (`state:
AWAITING_CHECKS` or later), the hand-off succeeded and `autoMergeRequest: null` is expected — no
action needed. Only work through the two sections below if the PR is genuinely absent from the
queue.

**Fix:** None. Do not re-run `gh pr merge --squash` to "re-arm" a `null` you haven't confirmed is a
real drop — it redundantly resets `enabledAt`/`enabledBy` for no reason, since the PR merges
normally once the queue processes it.

Motivating incident: [PR #939](https://github.com/merickvaughn/lifting-logbook/pull/939) (issue
[#936](https://github.com/merickvaughn/lifting-logbook/issues/936)), 2026-08-23 — observed live
while that very PR was merging; see
[#942](https://github.com/merickvaughn/lifting-logbook/issues/942) for the full diagnostic trace.

### Auto-merge silently cleared — a non-required check's cancelled run

**Pattern:** `.github/workflows/review-gate.yml` triggers on `issue_comment` (needed because the
`/review` marker is posted as a PR *comment*, not a push) with `concurrency: cancel-in-progress: true`.
Posting a second `/review` comment — the "re-run /review to refresh a stale marker" pattern documented
above under "Merge enqueues instead of landing" — cancels any in-flight run of that same workflow. The
cancelled run's job id was `review-gate` (lowercase/hyphenated; the job has no `name:` override, so
GitHub's automatic Check-Run entry displayed literally as `review-gate`) — a *different*,
**non-required** check from the `Review Gate` (capitalized, space) **commit status** branch protection
actually requires. The latter is posted separately via the raw Commit Status API (`-f context=Review
Gate`, hardcoded in the workflow's script step), completely decoupled from the job id —
[ADR-031](docs/adr/ADR-031-mandatory-review-gate.md) states the design intent directly: "Branch
protection's required-check matching is API-agnostic — it matches on context/check name, not which API
reported it" ([GitHub Docs — Troubleshooting required status
checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks)
confirms checks and commit statuses share the same name-based matching). Confirmed live:
`required_status_checks.contexts` lists only the capitalized `Review Gate` context, never `review-gate`.
Despite being non-required, the cancelled job's "fail" conclusion was enough for GitHub to silently drop
a standing `gh pr merge --squash` auto-merge request — observed/reproduced behavior, not something
GitHub's own auto-merge docs document either way (checked live).

**Symptom:** `gh pr view <N> --json autoMergeRequest` reads back `null` — with no error surfaced
anywhere — even though every *required* check has gone green, and `mergeStateStatus` reads `UNSTABLE`.
`gh pr checks <N>` shows the near-identical pair side by side with nothing but case and hyphenation to
tell them apart, e.g. (real output from PR #905):
```
review-gate	fail	55s
Review Gate	pass	0	Clean /review, no findings
```

**Diagnosis:** Confirm every *required* context is actually green, ignoring any non-required
lookalike:
```bash
gh api repos/merickvaughn/lifting-logbook/branches/main/protection/required_status_checks --jq .contexts
gh pr checks <N>
```
If every listed required context passes despite `autoMergeRequest: null`, the auto-merge request was
cleared by a non-required check's stale cancelled run, not a real blocker.

**Fix:** Re-issue the merge once required checks are confirmed green — it immediately re-queues with
no data loss:
```bash
gh pr merge <N> --squash
# "already queued to merge"
```

As of [#906](https://github.com/merickvaughn/lifting-logbook/issues/906), `review-gate.yml`'s job id
was renamed `review-gate` → `evaluate-review-marker` specifically to remove the visual collision in
`gh pr checks` output. The underlying mechanism — a non-required check's cancelled run clearing a
standing auto-merge request — is a GitHub-level behavior, not specific to this job, and can recur with
any workflow using `cancel-in-progress: true`; the fix above remains the durable remediation regardless
of job naming.

Motivating incident: [issue #906](https://github.com/merickvaughn/lifting-logbook/issues/906), found
while merging [PR #905](https://github.com/merickvaughn/lifting-logbook/pull/905) (2026-08-18).

### Auto-merge silently cleared — a force-push to the armed branch

**Pattern:** `gh pr merge <N> --squash` against this repo's merge-queue-protected `main` either
enqueues the PR immediately or arms `autoMergeRequest` so GitHub enqueues it once required checks
go green (see "Merge enqueues instead of landing" above). A **force-push** to that branch after the
request is armed — most commonly a `git rebase origin/main` + `git push --force-with-lease` while
the PR is still waiting on checks or a queue slot, needed because a sibling PR merged ahead of it
(a real scenario under this repo's concurrent-session throughput on shared files, not an edge case)
— silently clears the armed request, with no error or warning anywhere. Root cause (inferred, not
confirmed against GitHub's own docs): `autoMergeRequest` is presumably tied to the commit SHA it was
armed against, and a force-push changes `HEAD`'s SHA without GitHub carrying the auto-merge intent
forward to the new one.

**Symptom:** `gh pr view <N> --json autoMergeRequest` returns `null` after a rebase + force-push,
even though the identical query returned a populated object immediately after the earlier
`gh pr merge --squash` call that armed it.

**Fix:** After any force-push to a branch with a previously-armed `autoMergeRequest`, check and
re-arm — never assume a prior arming survives a subsequent rebase + force-push:
```bash
gh pr view <N> --json autoMergeRequest --jq .autoMergeRequest   # null means it was cleared
gh pr merge <N> --squash                                        # re-arms (or re-enqueues) it
```
This matters most for a PR that needs a rebase while it's actively waiting in the queue — check
`autoMergeRequest` again after every such force-push, not just once after the first `--squash` call.

Motivating incident: [PR #919](https://github.com/merickvaughn/lifting-logbook/pull/919) (issue
[#917](https://github.com/merickvaughn/lifting-logbook/issues/917)), 2026-08-21 — needed two rounds
of `git rebase origin/main` while queued behind sibling PRs merging ahead of it; the second rebase +
force-push cleared the arming unnoticed until `autoMergeRequest` was checked again and found `null`.

---

## Observability

This repo runs a full OpenTelemetry + Grafana Cloud stack. The Plan-then-optimize → Pass 3
**Observability** dimension defers to this section (per dev-env [ADR-042](https://github.com/brownm09/dev-env/blob/main/docs/adr/042-plan-risk-dimension-audit-and-observability-section.md)).

### Convention

- **Logging** — `nestjs-pino` (Pino), **structured JSON**, standard Pino levels (runtime-configurable). Configured in [`apps/api/src/app.module.ts`](apps/api/src/app.module.ts). Request/response headers are logged **redact-by-default**: a `serializers` allowlist (`LOGGABLE_REQUEST_HEADERS`) keeps only known-safe headers and drops everything else, so a newly-introduced auth-bearing header cannot leak the way `x-clerk-authorization` did (#767). A `redact.paths` denylist (`remove: true`) remains as a defense-in-depth backstop for the highest-risk bearer headers and cookies ([ADR-033](docs/adr/ADR-033-log-header-allowlist.md)). `/health` is excluded from auto-logging to control Grafana Cloud log spend.
- **Tracing & metrics** — OpenTelemetry NodeSDK in [`apps/api/src/otel.ts`](apps/api/src/otel.ts): `OTLPTraceExporter` + `OTLPMetricExporter` (OTLP/HTTP) with `getNodeAutoInstrumentations()` (HTTP/Fastify, `pg`, Node built-ins). Service name defaults to `lifting-logbook-api`. The web app instruments via `@vercel/otel` ([`apps/web/instrumentation.ts`](apps/web/instrumentation.ts)).
- **Backends** — Grafana Cloud via the OTel Collector: traces → **Tempo**, logs → **Loki**, metrics → **Mimir** (see [ADR-018](docs/adr/ADR-018-observability-stack.md)).
- **Log↔trace correlation** — a Pino `mixin()` injects `trace_id` / `span_id` from the active span into every log line, enabling bidirectional Loki↔Tempo navigation in Grafana.
- **Errors** — domain exceptions are mapped to HTTP responses by per-feature exception filters (e.g. `apps/api/src/programs/conflict.filter.ts`, `not-found.filter.ts`); request/response logging — including error responses, carrying `trace_id`/`span_id` via the `mixin` — is emitted by `nestjs-pino`/`pino-http` auto-logging. Error spans on the failing request are retained by the tail-based sampling policy ([ADR-020](docs/adr/ADR-020-tail-based-sampling-policy.md)).
- **Client-side write errors** — every `apps/web` mutation invoked from a Client Component (the writes re-exported by `apps/web/lib/client-api.ts`) reports its caught error through [`apps/web/lib/log-client-error.ts`](apps/web/lib/log-client-error.ts) (`logClientError('<op>', err, ctx?)`), which (1) emits a consistent, greppable `[client-mutation] <op> failed` line to the browser console — never a bare `console.error` or an empty `catch {}` — and (2) sends a best-effort same-origin beacon to the [`/api/client-errors`](apps/web/app/api/client-errors/route.ts) route handler, which records the error as an OTel span (`client.mutation.error`, status `ERROR`) so it lands in Grafana (Tempo, retained by the [ADR-020](docs/adr/ADR-020-tail-based-sampling-policy.md) tail-sampling `errors` policy). `apps/web` instruments only the server runtime (`@vercel/otel`, [`apps/web/instrumentation.ts`](apps/web/instrumentation.ts)) — there is no browser OTel SDK, so the same-origin beacon → server-span path is how a browser failure reaches Grafana, and `logClientError` is the single seam it attaches at. Implemented in [#798](https://github.com/merickvaughn/lifting-logbook/issues/798); origin [#783](https://github.com/merickvaughn/lifting-logbook/issues/783). Because the sink is public/unauthenticated and each accepted request records a *retained* ERROR span, [#806](https://github.com/merickvaughn/lifting-logbook/issues/806) added a **same-origin abuse guard** to the route handler: the `Origin` verdict is always tagged on the span (`client.origin.check`), and cross-origin browser beacons are dropped **only** when classified against the `CLIENT_ERROR_ALLOWED_ORIGINS` allowlist **and** `CLIENT_ERROR_DROP_CROSS_ORIGIN=true` (observe-only otherwise, so a false-drop can't silently kill the telemetry — validate `same-origin` in staging Tempo before enabling). Scripted/no-`Origin` abuse is out of scope for the app and belongs to an infra-level rate limit; see the [ADR-020](docs/adr/ADR-020-tail-based-sampling-policy.md) #806 addendum. In staging and production the allowlist is **derived at deploy** from each web service's own Cloud Run URL by the `client_error_guard` input of [`.github/actions/deploy-cloud-run-otel-sidecar`](.github/actions/deploy-cloud-run-otel-sidecar/action.yml) (no hard-coded origin, self-correcting if the URL changes), and enforcement is enabled by setting that action's `client_error_drop_cross_origin` input to `true` in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) — staging then prod, only after staging Tempo confirms legit beacons tag `same-origin` ([#809](https://github.com/merickvaughn/lifting-logbook/issues/809)).

### What the Observability audit dimension must verify for this repo

1. **Raw SQL is NOT auto-traced.** `@prisma/instrumentation` is excluded from the OTel SDK due to an SDK v1/v2 incompatibility ([ADR-024](docs/adr/ADR-024-prisma-otel-sdk-override.md)). Prisma Client ORM calls and any `$queryRaw` / `$executeRaw` emit **no spans**. Any new raw-SQL call site must be wrapped in a **manual span** to remain observable. (There are currently zero raw-SQL usages — this is a forward-looking gate.)
2. **LLM adapters apply NO PII scrubbing to prompts.** The cycle-planning adapters (`apps/api/src/adapters/llm/anthropic-cycle-planning.adapter.ts`, `openai-compatible-cycle-planning.adapter.ts`) send user context to the provider unscrubbed. New LLM call sites must consider prompt-content exposure before sending or logging.
3. **Header redaction is redact-by-default (allowlist), not a denylist.** Request/response headers are filtered to the `LOGGABLE_REQUEST_HEADERS` allowlist in `app.module.ts`; any header not explicitly marked safe is dropped, and `log-header-allowlist.spec.ts` fails CI if a credential-bearing name is added to the allowlist ([ADR-033](docs/adr/ADR-033-log-header-allowlist.md)). The allowlist covers **headers**, not payloads — new API boundaries must still log at appropriate levels and must never log secrets, tokens, or sensitive request/response **bodies**.
4. **Client-side mutations must not swallow errors.** Every write invoked from a Client Component must route its caught error through [`apps/web/lib/log-client-error.ts`](apps/web/lib/log-client-error.ts) (`logClientError`) — never an empty `catch {}`, a bare `console.error`, or an uncaught rejection. Context passed to the helper carries ids/actions only, never secrets, tokens, or request bodies (the api-client throws only `Error(message)`/`ApiClientError`, so the caught error itself is safe to log). See [#783](https://github.com/merickvaughn/lifting-logbook/issues/783).

### References

[ADR-018](docs/adr/ADR-018-observability-stack.md) (stack), [ADR-019](docs/adr/ADR-019-slo-methodology.md) (SLOs), [ADR-020](docs/adr/ADR-020-tail-based-sampling-policy.md) (tail sampling), [ADR-021](docs/adr/ADR-021-no-test-tracing.md) (no test tracing), [ADR-024](docs/adr/ADR-024-prisma-otel-sdk-override.md) (Prisma SDK override), [ADR-033](docs/adr/ADR-033-log-header-allowlist.md) (log header allowlist); operational runbook: [`docs/runbooks/observability.md`](docs/runbooks/observability.md).

---

## Documentation and Citations

When writing or updating any architectural documentation (ADRs, design docs, READMEs):

- **Every ADR must have a `## References` section.** New ADRs get one on creation. Existing ADRs get one when they receive substantive edits. See `docs/adr-references.md` for the established pattern.
- **Update `docs/adr-references.md`** whenever an ADR's references change — it is the consolidated index.
- **Cite primary sources, not summaries.** Three categories:
  - *Official documentation* — for technology and framework choices (NestJS, Next.js, Prisma, etc.)
  - *Specifications* — for protocol and standard choices (IETF RFCs, OASIS specs, GraphQL spec, OpenID Connect)
  - *Foundational writings* — for architectural patterns (Cockburn's Hexagonal Architecture, Uncle Bob's Clean Architecture, Fowler articles)
- **Regulatory references** (GDPR, HIPAA, SOC 2) must link to the primary regulatory source, not a summary or blog post.
- **When recommending a technology in any response**, include a link to its official documentation in that same response — not just the name.

---

## Engineering Journal

The engineering-journal workflow — per-session **stub** files, the sharded per-session **manifest**
and per-PR **open-PR** companion files, the project *and* meta journal update triggers, and the
end-of-day `/journal-compose` step — is owned in full by the global
[`CLAUDE.md`](https://github.com/brownm09/dev-env/blob/main/claude/CLAUDE.md) **→ Engineering
Journal** section. File formats (the stub template, the manifest / open-PR shard schemas) and the
canonical 11-section compose structure live in that repo's
[`docs/REFERENCE.md` → Engineering Journal Internals](https://github.com/brownm09/dev-env/blob/main/docs/REFERENCE.md#engineering-journal-internals).

**Follow the global workflow as written — do not duplicate or re-derive it here.** This repo's
session hooks already emit the sharded stub / `open-prs/<N>.json` reminders directly after a PR is
opened or merged.

The only lifting-logbook-specific parameter is the **project journal path:**
`sessions/lifting-logbook/` — substitute it wherever the global workflow says `sessions/<project>/`
(the `YYYY-MM-DD_HHMMSS.stub.md` files, the `*.manifest.jsonl` shards, the `open-prs/<N>.json`
shards, and `reports/`).

> Historical note: this section previously documented a single-draft-file-per-day workflow
> (`YYYY-MM-DD_draft.md` hand-edited across sessions, composed at day end). That workflow was
> retired when the global config moved to the sharded stub/manifest system; see
> [#772](https://github.com/merickvaughn/lifting-logbook/issues/772).
