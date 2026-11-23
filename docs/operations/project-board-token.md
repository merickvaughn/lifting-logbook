# Project-board token (`PROJECT_BOARD_TOKEN`)

[`.github/workflows/project-board.yml`](../../.github/workflows/project-board.yml) adds every new
issue to the Lifting Logbook project and sets its Epic from an `epic:<slug>` label
([#1385](https://github.com/merickvaughn/lifting-logbook/issues/1385)). The project is project 2 of
the `merickvaughn` **organization**, at <https://github.com/orgs/merickvaughn/projects/2>, and it is
private. A workflow's own `GITHUB_TOKEN` is scoped to its repository and can't write to an
organization's project, so the workflow uses a personal access token stored as the repository
secret `PROJECT_BOARD_TOKEN`.

## Scope

| # | Setting | Value | Why |
|---|---|---|---|
| 1 | Token type | Fine-grained personal access token | The [`actions/add-to-project` README](https://github.com/actions/add-to-project#creating-a-pat-and-adding-it-to-your-repository) offers a classic token with the `project` scope or a fine-grained one. The classic scope reaches every project the account can reach, under every owner. The fine-grained token reaches only this organization's projects and this repository. |
| 2 | Resource owner | `merickvaughn` | The organization that owns project 2. |
| 3 | Repository access | Only `merickvaughn/lifting-logbook` | The workflow reads issues from this repository only. |
| 4 | Repository permissions | Issues: read-only; Pull requests: read-only | What the README asks for. The workflow runs on issues only; both are read-only, on a public repository. |
| 5 | Organization permissions | Projects: read and write | Adding the item and setting its Epic. |
| 6 | Account | One with write access to project 2 | The token acts as that account on the board. |
| 7 | Expiry | 90 days | GitHub emails the account before a token expires. |

If the organization doesn't allow fine-grained tokens (its *Settings → Personal access tokens*
policy), the fallback is a classic token with the `project` scope only, at
<https://github.com/settings/tokens/new?scopes=project&description=lifting-logbook%20project-board>.
`repo` isn't needed, because this repository is public.

What a leak would expose: write access to the `merickvaughn` organization's projects, and read
access to this repository's issues and pull requests, which are public anyway. The workflow never
prints the token: it reaches `actions/add-to-project` as an input and `gh` as `GH_TOKEN`, and
GitHub masks secrets in logs. The workflow runs on `issues` events only, and with
`permissions: {}` apart from `contents: read` for its own checkout.

Who can use it: no API or web page returns a secret's value, so tools and sessions outside GitHub
Actions (Claude sessions, Claude Design, Artifacts) can reach the board only through this workflow,
by opening an issue or adding an `epic:` label. The workflow does nothing beyond adding the issue
and setting its Epic. Anyone who can push a branch to this repository, including the Claude Code
GitHub Action, could still write a workflow that uses the secret, since `pull_request` runs from
branches in this repository get repository secrets. That is the same exposure as the repository's
other secrets.

## Create or rotate

1. Create the token at <https://github.com/settings/personal-access-tokens/new>, signed in as the
   account from row 6, with the settings in rows 1–5 and 7. Name it `lifting-logbook project-board`.
2. If the organization requires approval for fine-grained tokens, an organization owner approves
   the request at <https://github.com/organizations/merickvaughn/settings/personal-access-token-requests>.
3. Store it (`gh` prompts for the value, so it never lands in shell history):
   ```bash
   gh secret set PROJECT_BOARD_TOKEN -R merickvaughn/lifting-logbook
   ```
4. Check that it's there: `gh secret list -R merickvaughn/lifting-logbook` lists
   `PROJECT_BOARD_TOKEN` with today's date.
5. On a rotation, delete the old token at <https://github.com/settings/personal-access-tokens>
   (or <https://github.com/settings/tokens> for a classic one).
6. Check it works: re-run the latest
   [Project board run](https://github.com/merickvaughn/lifting-logbook/actions/workflows/project-board.yml),
   or add an `epic:` label to an issue, and confirm the run is green and the issue's Epic is set.

## When the token has expired

The "Add the issue to the project" step fails with `Bad credentials`, and new issues stop reaching
the board. Rotate the token as above, then place the issues opened in the meantime with the manual
commands in `CLAUDE.md` → *Workflow — run after `gh issue create`*, or re-run their failed runs.
