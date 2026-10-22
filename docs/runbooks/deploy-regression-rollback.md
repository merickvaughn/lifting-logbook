# Runbook: Deploy Regression Rollback

**Triggers:** Error rate spike in Grafana that starts immediately after a recent deployment;
`APIHighErrorRate` alert correlated with a `kubectl rollout history` entry in the last 60 minutes
**Default severity:** SEV2 — escalate to SEV1 if error rate exceeds 10% or if data integrity
is at risk
**Dashboard:** Grafana → Lifting Logbook → API RED → Error Rate panel

---

## Symptom

- `APIHighErrorRate` alert fires shortly after a deploy
- The Error Rate panel in API RED shows a sharp step-change (not a gradual drift) at a
  time that matches a recent `kubectl rollout` event
- New errors appear in structured logs that were not present before the deploy
- Traces show failures in code paths touched by the recent change

---

## Likely causes

1. **Code bug introduced by the deploy** — a regression in the new image causes requests
   to fail on a code path that was not covered by tests.
2. **Missing or changed environment variable** — the new version expects an env var that
   is not set, or an existing var was renamed.
3. **Schema migration applied incorrectly** — a Prisma migration ran against the database
   and is incompatible with the running application version.
4. **Dependency version conflict** — a new `node_modules` dependency has a breaking change
   or is incompatible with an existing package.

---

## Diagnosis

### 1. Confirm the deploy timing

```sh
kubectl rollout history deployment/api
```

Find the most recent revision number and the timestamp. Compare to when the error rate
spiked in Grafana.

### 2. Check what changed

```sh
kubectl rollout history deployment/api --revision=<latest-revision>
```

Note the image tag. In the GitHub repository, find the commit corresponding to that tag.

**Faster alternative:** `bash scripts/check-deployed-version.sh` curls each service's
`/version` endpoint directly and prints `git log -1` context for the returned SHA in one step,
skipping the manual `kubectl rollout history` + tag lookup. See
[`checking-deployed-version.md`](checking-deployed-version.md).

### 3. Identify the failing code path

In Grafana Explore → Tempo:

```
{ .http.status_code >= 500 }
```

Open a failing trace and read `exception.message` and `exception.stacktrace` to identify
which function is throwing.

In Grafana Explore → Loki:

```logql
{service_name="lifting-logbook-api"} |= "error" | json
```

### 4. Verify there are no pending migrations

A migration that already ran cannot be rolled back by reverting the deployment alone —
the schema change is in the database. Check whether the deploy included a migration:

```sh
git log <previous-tag>..<current-tag> -- apps/api/prisma/migrations/
```

If migrations were included, proceed with caution and escalate before rolling back.

---

## Remediation

### Fast path: rollback the deployment

If no schema migrations were included and the root cause is a code bug, roll back
immediately:

```sh
kubectl rollout undo deployment/api
```

Wait for the rollback to complete:

```sh
kubectl rollout status deployment/api
```

Verify the error rate drops in Grafana within 2 minutes of the rollback completing. If
it does not drop, the rollback did not revert the cause — investigate further.

### Fast path on Cloud Run: route traffic to the previous revision

Both environments run Cloud-Run-only (GKE is disabled, ADR-009 / #860), so this is the usual
rollback. Find the last good revision, then send all traffic to it:

```sh
gcloud run revisions list --service=lifting-logbook-prod-api \
  --region=us-central1 --project=lifting-logbook-prod --limit=5

gcloud run services update-traffic lifting-logbook-prod-api \
  --to-revisions=PREVIOUS_REVISION=100 \
  --region=us-central1 --project=lifting-logbook-prod
```

**This pins traffic.** After `--to-revisions`, the service routes to that named revision
instead of "latest". Any revision created later starts at **0% traffic**, so a later deploy
succeeds without serving anything. Check the pin:

```sh
gcloud run services describe lifting-logbook-prod-api \
  --region=us-central1 --project=lifting-logbook-prod --format='yaml(status.traffic)'
```

A pinned service lists a `revisionName` with `percent: 100` and no `latestRevision: true`.

**The next pipeline deploy removes the pin.** Since #1042, every deploy through
`.github/actions/deploy-cloud-run-otel-sidecar` routes 100% of traffic to the revision it
creates, then fails the job if that revision is not serving. So a Cloud Run rollback lasts
only until the next deploy of that service. In production that deploy waits for the
`environment: production` approval, so the approver decides when the rollback ends. Do not
approve a deploy of the broken commit.

**To unpin by hand**, without deploying (for example after rolling back to check a theory):

```sh
gcloud run services update-traffic lifting-logbook-prod-api \
  --to-latest \
  --region=us-central1 --project=lifting-logbook-prod
```

Staging is the same, with `lifting-logbook-stg-api` / `lifting-logbook-stg-web` in
`lifting-logbook-staging`. A staging pin is never harmless: from 2026-07-10 to 2026-10-09 a
forgotten pin on `lifting-logbook-stg-api` meant every PR's `Staging Integration Tests` ran
against a July build (#1042). Unpin staging as soon as you are done with it.

### If migrations were applied

Do not roll back the deployment until the impact of the migration is understood:

1. Escalate to the engineering lead immediately.
2. Check whether the previous application version is compatible with the current schema
   (i.e., is the migration additive-only, or did it drop or alter columns?).
3. If the migration is additive-only (new table or new nullable column), rolling back
   the deployment is safe — the old code will ignore the new schema.
4. If the migration altered or dropped columns, do not roll back without first writing a
   compensating migration. Rolling back the code without rolling back the schema will
   cause the old code to fail against the new schema.

### If the rollback resolves the issue

1. Verify the error rate is below the alert threshold for at least 10 minutes.
2. Resolve the alert in Grafana.
3. Open a GitHub issue on the specific regression with the failing trace attached.
4. Do not re-deploy the broken version. Fix the regression in a new branch and re-deploy.

---

## Escalation

If the rollback does not resolve the error rate, or if the deploy included migrations:

1. Escalate to SEV1 and loop in the engineering lead.
2. Share:
   - The diff between the previous and current image tag (`git log`)
   - The failing trace from Grafana Tempo
   - Whether migrations were applied
3. Do not attempt to manually edit the database without explicit guidance.
