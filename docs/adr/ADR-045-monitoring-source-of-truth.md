# ADR-045: Terraform Is the Only Source of Truth for Grafana Cloud Monitoring Resources

**Status:** Accepted
**Date:** 2026-11-19
**Issue:** [#843](https://github.com/merickvaughn/lifting-logbook/issues/843) (part of [#840](https://github.com/merickvaughn/lifting-logbook/issues/840), Wave 0)
**Related:** [ADR-018](ADR-018-observability-stack.md) (observability stack); [ADR-019](ADR-019-slo-methodology.md) (SLOs and the deferred burn-rate rules); [ADR-032](ADR-032-cloud-run-api-public-invoker.md) (the #770 fix); retro [#821](https://github.com/merickvaughn/lifting-logbook/issues/821)

---

## Context

The alert rules (`infra/observability/alerts/api.yaml`), the Alertmanager config
(`infra/observability/alertmanager.yaml`) and the dashboards (`infra/observability/dashboards/`)
are kept as code, but only the rules and Alertmanager config reach Grafana Cloud, and only when
someone runs `mimirtool rules load` and `mimirtool alertmanager load` by hand
([`docs/operations/slo.md`](../operations/slo.md#applying-alert-config-to-grafana-cloud)). The
dashboards are provisioned only into the local docker-compose Grafana. Wave 2 of #840 provisions
all of these as code, alongside ADR-019's deferred burn-rate rules.

Retro #821 named a failure class to avoid: one resource with two writers, Terraform state and a flag
in `deploy.yml`. It caused the accidental RLS cutover and the month-long CORS write outage (#770),
where Terraform granted the API's public invoker but every deploy re-locked it with
`--no-allow-unauthenticated`, so a Terraform-only fix reverted on the next deploy. Choosing one
writer for monitoring resources before Wave 2 builds one keeps that class from starting again.

Two options were on the table:

- **A. A `deploy.yml` step** that runs `mimirtool` on every deploy against the config in
  `infra/observability/`. Simplest, and no state file.
- **B. The Grafana Terraform provider.** Declarative, and drift shows up in the production plan
  that `prod-plan-pr.yml` posts, at the cost of a provider and more state.

## Decision

1. **Option B. The Grafana Terraform provider is the single source of truth** for Grafana Cloud
   monitoring resources: alert rules, Alertmanager config (contact points, routing) and dashboards.
   Their definitions stay in the repo, and Terraform applies them to Grafana Cloud.
2. **Nothing but Terraform changes a monitoring resource once Terraform manages it.** That rules out
   a `deploy.yml` step, any other workflow, a manual `mimirtool` load and an edit in the Grafana
   Cloud UI. A change goes through Terraform, or it's drift that the next plan reports and the next
   apply reverts.
3. **Until Terraform provisioning lands, the manual `mimirtool` procedure stays as an interim
   step.** [`docs/operations/slo.md`](../operations/slo.md#applying-alert-config-to-grafana-cloud)
   keeps it, and the Wave-2 change that puts a resource under Terraform retires the procedure for
   that resource in the same PR. No workflow gains a `mimirtool` step in the meantime.

## Alternatives considered

### A. `mimirtool` load in a `deploy.yml` step — rejected

- **No drift detection.** A load overwrites what's in Grafana Cloud and reports nothing about how
  it differed. An edit made in the UI between deploys stays invisible until the next deploy
  silently reverts it, and nothing shows it in review. Terraform's plan shows the difference before
  anything changes, and `prod-plan-pr.yml` already puts that plan on each PR.
- **A second source beside Terraform state.** Terraform already manages the rest of the
  infrastructure. A deploy step that writes monitoring resources makes `deploy.yml` a second
  writer of infrastructure, the dual-source class behind #770 and retro #821. If Terraform ever
  took over part of monitoring as well, the two would overwrite each other on every deploy, the
  way the invoker grant did.

## Consequences

- **Wave 2 adds the `grafana/grafana` provider and its state** to `infra/terraform/`, plus a Grafana
  Cloud credential for CI's plan and apply. That's more surface than a `mimirtool` step, accepted
  for drift detection and a single writer.
- **The rule extends to Wave 4.** It's the first instance of the rule that #821's dual-source
  elimination work applies to the IAM invoker, `--allow-unauthenticated` and secret sync: one
  resource, one writer.
- **A reviewer can reject** any workflow or script that writes a Grafana Cloud monitoring resource
  outside Terraform, citing this ADR.

## References

1. Grafana Labs, [Terraform provider `grafana/grafana` documentation](https://registry.terraform.io/providers/grafana/grafana/latest/docs) — resources for Grafana Cloud alert rules, contact points, notification policies and dashboards, the resources Terraform takes over.
2. Grafana Labs, [Grafana Cloud — Infrastructure as code with Terraform](https://grafana.com/docs/grafana-cloud/developer-resources/infrastructure-as-code/terraform/) — Grafana's guide to managing Grafana Cloud with the provider.
3. Grafana Labs, [Grafana Mimir — `mimirtool`](https://grafana.com/docs/mimir/latest/manage/tools/mimirtool/) — `rules load` and `alertmanager load`, the interim manual procedure and option A's mechanism.
4. HashiCorp, [Terraform — `terraform plan`](https://developer.hashicorp.com/terraform/cli/commands/plan) — a plan compares state and real infrastructure with the configuration and reports drift before anything changes.
