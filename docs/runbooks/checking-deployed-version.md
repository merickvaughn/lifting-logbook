# Checking the Deployed Version

Reports what commit is actually running in staging and production right now, via each
service's `GET /version` endpoint. Closes the gap from the 2026-07-03 incident (#670): a
`deploy.yml` run was silently cancelled mid-flight (see the `concurrency:` block's header
comment in [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml), #401) and
there was no fast way to confirm what had actually shipped without a Cloud Console detour.

---

## The `/version` endpoint

Both `apps/api` and `apps/web` expose an unauthenticated-at-the-app-level `GET /version`
(#671) reporting the git commit baked into the running container image at build time:

```json
{ "gitSha": "<40-char sha, or \"unknown\">", "environment": "<DEPLOYMENT_ENVIRONMENT>" }
```

- [`apps/api/src/health/health.controller.ts`](../../apps/api/src/health/health.controller.ts) — `@Public() @Get('version')`
- [`apps/web/app/version/route.ts`](../../apps/web/app/version/route.ts) — excluded from Clerk middleware entirely (see the matcher in [`apps/web/middleware.ts`](../../apps/web/middleware.ts))

`gitSha` degrades to `"unknown"` rather than throwing if `GIT_SHA` was never baked in (e.g. a
manual `docker build` without `--build-arg GIT_SHA=...`) — a missing SHA only degrades
observability, not functionality.

**`environment` is `DEPLOYMENT_ENVIRONMENT`: `staging` or `production`.** The deploy sets it on
each Cloud Run service through the `deploy-cloud-run-otel-sidecar` action's `ingress_env`, and
`deploy.yml`'s `/version` smoke steps fail unless web and api both report the environment they
deployed to (`CHECK_SERVED_VERSION_ENVIRONMENT`). Web never reads `NODE_ENV` here: `next build`
pins it to `production`, which is how staging's web once reported `"environment":"production"`
(#1448). The api falls back to `NODE_ENV` where the variable is unset; web falls back to
`development`. A service that hasn't been deployed since #1448 may still show the old value.

**On staging, the reported SHA can lag the PR's actual head commit.** `staging.yml`'s
"Resolve image tag" step reuses a prior image (via a floating `pr-<N>` tag) when a push's diff
is judged non-image-affecting, rather than rebuilding. On such a run, the baked-in `GIT_SHA` —
and therefore what `/version` reports — reflects whichever earlier commit in the PR actually
triggered the last real build, not the current head. This is documented in detail in the
"Resolve image tag" step's comment in `staging.yml` (#671). Production never takes this
shortcut — every production deploy builds and tags images against `github.sha` directly.

### Reaching it

| Service | Auth |
|---|---|
| `lifting-logbook-{stg,prod}-web` | none — `--allow-unauthenticated` |
| `lifting-logbook-{stg,prod}-api` | Cloud Run identity token — `--no-allow-unauthenticated` |

For the api services, mint a token the same way the deploy pipeline's own smoke test does
(`.github/workflows/deploy.yml`, "Smoke test Cloud Run production — /readyz"):

```sh
gcloud auth print-identity-token \
  --impersonate-service-account=<cicd-service-account-email> \
  --audiences=<api-service-url> \
  --include-email
```

then `curl -H "Authorization: Bearer $ID_TOKEN" <api-url>/version`. This requires
`roles/iam.serviceAccountTokenCreator` on the impersonated CI/CD service account.

---

## `scripts/check-deployed-version.sh`

Automates the above for all 4 services (staging + production, api + web) in one command, and
prints `git log -1` context for each returned SHA so you can immediately see what that commit
actually was — no separate `git log`/GitHub lookup needed. Attempts every check even if one
fails, and reports an aggregate pass/fail summary at the end.

```sh
bash scripts/check-deployed-version.sh                    # both environments
bash scripts/check-deployed-version.sh --env staging       # staging only
```

Requires `gcloud`, authenticated, with `roles/iam.serviceAccountTokenCreator` on the relevant
CI/CD service account (the same `GCP_STAGING_SERVICE_ACCOUNT` / `GCP_PROD_SERVICE_ACCOUNT` used
in `.github/workflows/deploy.yml` — see [`docs/deploy.md`](../deploy.md)) to mint identity
tokens for the `*-api` checks; the `*-web` checks need no auth.

Full flag reference: `bash scripts/check-deployed-version.sh --help`.

---

## Automated audit in the deploy pipeline

Every `deploy.yml` production deploy prints the deployed SHA + commit link in its job summary,
and separately audits any `cancelled` `deploy.yml` runs on `main` since the last successful
run — checking whether each cancelled run's changes made it into what actually shipped
(`git merge-base --is-ancestor`). See the "Audit cancelled deploy runs since last success" step
in `deploy-production` (`.github/workflows/deploy.yml`). This is advisory (never fails the
deploy) and is the automated version of the manual check this runbook otherwise describes.

**The job-summary SHA and `check-deployed-version.sh`'s SHA answer different questions.** The
job summary reports what a specific run *deployed at the time it ran*; the script reports what's
*actually live right now*. These are usually the same commit, but can diverge — most commonly on
staging after an image-reuse (skip-build) deploy, per the gotcha above. If the two disagree,
trust the script — it reflects the live `/version` endpoint, not a historical CI record.

---

## References

- [GitHub Actions — Adding a job summary](https://docs.github.com/en/actions/how-tos/write-scripts/add-a-job-summary) — `GITHUB_STEP_SUMMARY` semantics and GFM rendering
- [GitHub CLI — `gh run list`](https://cli.github.com/manual/gh_run_list) — flags for filtering runs by workflow, branch, status, and creation date
- [Git — `git-merge-base`](https://git-scm.com/docs/git-merge-base) — `--is-ancestor` exit-code semantics
- [Google Cloud — Authenticating service-to-service](https://cloud.google.com/run/docs/authenticating/service-to-service) — Cloud Run identity tokens and service account impersonation
- [Google Cloud — `gcloud auth print-identity-token`](https://cloud.google.com/sdk/gcloud/reference/auth/print-identity-token) — command reference
