# Runbook: Turn the import Assign step off

**Triggers:** a decision to stop new assigned imports in an environment: an Assign-step bug, a bad
suggestion rate, or a rollout paused before production.
**Default severity:** SEV3. Turning the flag off loses nothing and blocks only new assigned imports.
**Dashboard:** Grafana → Explore → Loki, `{service_name="lifting-logbook-api"} |= "import"`

---

## Symptom

Something is wrong with the importer's Assign step ([#1173](https://github.com/merickvaughn/lifting-logbook/issues/1173)),
and it should stop taking new imports while the fix is made. Examples:

- assigned imports write macrocycles or statuses the lifter didn't choose;
- the Assign step fails or errors for files that should import;
- the rollout needs to pause after staging.

## Likely causes

Not applicable: this runbook is the remedy. The flag gates every path that writes through the Assign
step, so turning it off is the normal way back
([proposal → Rollout and revert](../proposals/2026-11-06-import-macrocycle-assignment.md#rollout-and-revert), item 3).

## Diagnosis

Check whether the flag is on in an environment. The API reads `IMPORT_ASSIGN_ENABLED` and turns
Assign on only for the exact value `true` (`apps/api/src/programs/import-assign.ts`).

```bash
gcloud run services describe lifting-logbook-stg-api --region=us-central1 \
  --project=<GCP_STAGING_PROJECT_ID> \
  --format='yaml(spec.template.spec.containers[0].env)' | grep -A1 IMPORT_ASSIGN_ENABLED
```

For production, use `lifting-logbook-prod-api` and the production project. A dry-run import
response also carries `assignEnabled`.

## Remediation

### What turning it off does

- The import wizard shows the steps and required columns it showed before Assign. A file without
  program, macrocycle and workout columns can't be imported.
- The import endpoint answers `mode=assign` with a 404 and refuses a commit that sends a breakdown
  (`apps/api/src/programs/import.controller.ts`).
- **Stored rows stay.** Macrocycles, sets and statuses written by earlier assigned imports are left
  alone, and each import can still be undone from the History page's Macrocycles tab. Undo isn't
  behind the flag. History opens on the lifter's active program, and its Program picker shows any
  other program they imported into, whether or not that program has a current macrocycle
  ([#1300](https://github.com/merickvaughn/lifting-logbook/issues/1300)).

### Turn it off through the deploy (the durable way)

The deploy sets the flag on the API's ingress container on every run, so change it there:

1. In `.github/workflows/deploy.yml`, set the API deploy step's `ingress_env` to
   `IMPORT_ASSIGN_ENABLED=false` for each environment to turn off. Staging has one step in
   `deploy-staging`, production one in `deploy-production`. For staging, make the same change in
   `.github/workflows/staging.yml` (`deploy-api`), which deploys staging for pull requests.
2. Set `env.IMPORT_ASSIGN_ENABLED: "false"` in `infra/kubernetes/values/<env>-api.yaml`, so the
   optional GKE target matches.
3. Merge. The `Deploy` run redeploys the API with the flag off; production waits for its approval
   gate as usual.

**Set the value to `false`; don't delete the line.** The deploy keeps every env var already on the
live service and only overrides the ones it's given, so removing the line leaves `true` in place.

### Turn it off now, ahead of a deploy

If it can't wait for a merge, update the live service directly. This makes a new revision with
only the flag changed:

```bash
gcloud run services update lifting-logbook-prod-api --region=us-central1 \
  --project=<GCP_PROD_PROJECT_ID> \
  --container=api --update-env-vars=IMPORT_ASSIGN_ENABLED=false
```

Then make the deploy change above as well. Otherwise the next deploy sets the flag back to what
the workflow says.

### Verify

Repeat the Diagnosis command, which should show `false`. Then start an import in the app: the wizard
should ask for program, macrocycle and workout columns and show no Assign step.

## Escalation

If stored rows are wrong, turning the flag off won't change them. Undo the affected imports from
the History page, and open an issue with the import batch ids from the API logs. Reverting the
macrocycle-numbering code isn't safe once imported rows exist (proposal → Rollout and revert,
item 4).
