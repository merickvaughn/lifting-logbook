# Runbooks

Runbooks for known failure modes. Each file follows a fixed template:
**Symptom → Likely causes → Diagnosis → Remediation → Escalation.**

For severity levels, escalation paths, and the incident response checklist, see
[`docs/operations/on-call.md`](../operations/on-call.md).

---

## Index

| Runbook | Trigger | Default severity |
|---|---|---|
| [Observability stack](observability.md) | Local dev / Grafana access reference | N/A |
| [Checking the deployed version](checking-deployed-version.md) | Confirming what commit is live in staging/production | N/A |
| [API 5xx surge](api-5xx-surge.md) | `APIHighErrorRate` alert | SEV2 |
| [Database unreachable](database-unreachable.md) | DB connection errors in structured logs | SEV1 |
| [Auth provider outage](auth-provider-outage.md) | 401/403 surge + Clerk status incident | SEV2 |
| [Deploy regression rollback](deploy-regression-rollback.md) | Error rate spike correlated with recent deploy | SEV2 |
| [Staging CI flakiness](staging-ci-flakiness.md) | `staging.yml` red runs that pass on re-run | SEV3 |
| [Macrocycle rename rollback](macrocycle-rename-rollback.md) | Reverting ADR-038 / PR #1041 after its rename migration ran | SEV2 |

---

## Runbook template

When adding a new runbook, use this structure:

```markdown
# Runbook: <Title>

**Triggers:** <alert name or log pattern>
**Default severity:** SEV1 / SEV2 / SEV3
**Dashboard:** <Grafana path>

---

## Symptom
<What the on-call engineer sees: alert text, dashboard state, error messages>

## Likely causes
<Ordered by probability — most common first>
1.
2.
3.

## Diagnosis
<Concrete steps: Grafana panels to check, LogQL/TraceQL queries, kubectl commands>

## Remediation
<Ordered action list — stop when the symptom resolves>
1.
2.
3.

## Escalation
<Who to loop in if the runbook does not resolve the issue>
```
