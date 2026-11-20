# Project-board token (`PROJECT_BOARD_TOKEN`)

[`.github/workflows/project-board.yml`](../../.github/workflows/project-board.yml) adds every new
issue to the Lifting Logbook project (project 2, owned by the `merickvaughn` user account) and sets
its Epic from an `epic:<slug>` label ([#1385](https://github.com/merickvaughn/lifting-logbook/issues/1385)).
The workflow's own `GITHUB_TOKEN` can't write to a project owned by a user account, so it uses a
personal access token stored as the repository secret `PROJECT_BOARD_TOKEN`.

## Scope

| # | Setting | Value | Why |
|---|---|---|---|
| 1 | Token type | Personal access token (classic) | The [`actions/add-to-project` README](https://github.com/actions/add-to-project#creating-a-pat-and-adding-it-to-your-repository) offers a fine-grained token only through *Organization permissions → Projects*, which a user-owned project doesn't have. |
| 2 | Scopes | `project` only | The README requires `project`, plus `repo` only for a private repository. This repository is public, so the issue lookup in the "Set the Epic field" step needs no repository scope either. |
| 3 | Owner | An account with write access to project 2 | The token acts as that account on the board. |
| 4 | Expiry | 90 days | GitHub emails the owner before a token expires. |

What a leak would expose: the classic `project` scope gives read and write access to **every**
project the owning account can reach, not only project 2, and nothing in any repository. The
workflow never prints the token: it reaches `actions/add-to-project` as an input and `gh` as
`GH_TOKEN`, and GitHub masks secrets in logs. The workflow runs on `issues` events only, and with
`permissions: {}` apart from `contents: read` for its own checkout.

Who can use it: no API or web page returns a secret's value, so tools and sessions outside GitHub
Actions (Claude sessions, Claude Design, Artifacts) can reach the board only through this workflow,
by opening an issue or adding an `epic:` label. The workflow does nothing beyond adding the issue
and setting its Epic. Anyone who can push a branch to this repository, including the Claude Code
GitHub Action, could still write a workflow that uses the secret, since `pull_request` runs from
branches in this repository get repository secrets. That is the same exposure as the repository's
other secrets.

## Create or rotate

1. Create the token at
   <https://github.com/settings/tokens/new?scopes=project&description=lifting-logbook%20project-board>,
   signed in as the owner from row 3. Keep only `project` ticked, and set the expiry from row 4.
2. Store it (`gh` prompts for the value, so it never lands in shell history):
   ```bash
   gh secret set PROJECT_BOARD_TOKEN -R merickvaughn/lifting-logbook
   ```
3. Check that it's there: `gh secret list -R merickvaughn/lifting-logbook` lists
   `PROJECT_BOARD_TOKEN` with today's date.
4. On a rotation, delete the old token at <https://github.com/settings/tokens>.
5. Check it works: re-run the latest
   [Project board run](https://github.com/merickvaughn/lifting-logbook/actions/workflows/project-board.yml),
   or add an `epic:` label to an issue, and confirm the run is green and the issue's Epic is set.

## When the token has expired

The "Add the issue to the project" step fails with `Bad credentials`, and new issues stop reaching
the board. Rotate the token as above, then place the issues opened in the meantime with the manual
commands in `CLAUDE.md` → *Workflow — run after `gh issue create`*, or re-run their failed runs.
