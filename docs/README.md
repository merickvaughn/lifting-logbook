# Project Context: Gas Lifting Logbook — Cloud-Native Evolution

## Overview

Gas Lifting Logbook is a personal strength training tracker originally built as a Google Apps
Script (GAS) application backed by Google Sheets. It implements a structured lifting program
(Reverse Pyramid Training-style periodization with 5/3/1 variants planned), tracking training maxes, cycle dashboards, workout
sheets, and lift records across multiple lifts.

This document captures the architectural context for the cloud-native evolution of the project:
a multi-user, platform-agnostic version intended for deployment on modern cloud infrastructure.

---

## History

The original application was built as a GAS project deployed against a single Google Sheets
workbook. It evolved through a `legacy/` phase (monolithic script files) into a structured
TypeScript codebase with a clean `core/` (pure domain logic) and `api/` (GAS adapter) separation.
That separation is the key asset being carried forward.

---

## Goals for the Cloud-Native Version

### Functional

- Support multiple users, each with independent data and configuration
- Provide a web UI that replaces the spreadsheet-based interface
- Provide a native mobile experience (Android-first)
- Support multiple data store backends, starting with Google Sheets and Postgres

### Non-Functional

- Demonstrate enterprise-grade architectural patterns suitable for a director of engineering
  portfolio
- Show awareness of compliance requirements (GDPR, HIPAA) even where not currently applicable
- Enable meaningful A/B comparisons across infrastructure, API style, and mobile client choices
- Maintain a clear separation between domain logic and infrastructure concerns at all times

---

## Intended Audience

This project serves two audiences simultaneously:

1. **End users** — individuals tracking their lifting program who want a polished web or mobile
   experience
2. **Technical evaluators** — engineering leaders and hiring committees assessing architectural
   depth, decision-making quality, and breadth of modern platform knowledge

[Architecture Decision Records](adr/) and this context document are written with both audiences
in mind. Technical rationale is explicit; alternatives are documented; compliance and operational
tradeoffs are surfaced even where the simpler path is chosen.

---

## Repository Structure (Cloud-Native Target)

```
monorepo/
  packages/
    core/          # Portable domain logic (services, models, parsers, mappers)
    types/         # Shared TypeScript types and API contracts
  apps/
    api/           # Node.js HTTP server (NestJS primary, Express legacy comparison)
    web/           # Next.js App Router frontend
    mobile/        # React Native (Expo) — first pass; native Kotlin to follow
  infra/
    kubernetes/    # GKE Autopilot manifests and Helm charts (primary)
    cloud-run/     # Cloud Run service YAML (A/B comparison target)
    terraform/     # Shared infrastructure: VPC, load balancer, DNS, IAM
  docs/
    adr/           # Architecture Decision Records
    README.md      # This file
```

---

## Key Architectural Principles

1. **Hexagonal architecture (Ports & Adapters):** Domain logic is isolated from infrastructure.
   All external dependencies (data stores, auth providers, transport protocols) are accessed
   through defined interfaces (ports) and implemented as swappable adapters.
   See [ADR-002](adr/ADR-002-ports-and-adapters.md).

2. **Per-user adapter resolution:** The data store adapter used for a given request is resolved
   from the authenticated user's stored configuration, not from a global deployment setting.
   This supports gradual migration and heterogeneous data store usage across users.
   See [ADR-003](adr/ADR-003-per-user-data-store-config.md).

3. **Transport-layer neutrality:** The same service layer is exposed via both REST and GraphQL.
   Neither transport has privileged access to domain logic.
   See [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md).

4. **Infrastructure portability:** The application is containerized and can be deployed to
   Kubernetes or Cloud Run without code changes. Infrastructure differences are expressed
   entirely in deployment manifests.
   See [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md).

5. **Explicit tradeoffs:** Every significant architectural decision is documented with its
   rationale, alternatives considered, and known consequences. Simpler choices are not
   automatically preferred over more capable ones when the capability serves a documented goal.

---

## Technology Choices at a Glance

| Concern              | Choice                                            | Notes                             | ADR                                                                                                         |
| -------------------- | ------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Domain logic         | TypeScript (existing `core/`)                     | Unchanged from GAS version        | —                                                                                                           |
| Monorepo tooling     | Turborepo                                         | Build orchestration               | [ADR-001](adr/ADR-001-monorepo-structure.md)                                                                |
| Architecture pattern | Hexagonal (Ports & Adapters)                      | Core isolated from infrastructure | [ADR-002](adr/ADR-002-ports-and-adapters.md)                                                                |
| Per-user config      | Repository factory                                | Adapter resolved per request      | [ADR-003](adr/ADR-003-per-user-data-store-config.md)                                                        |
| Data store (v1)      | Google Sheets                                     | Per-user spreadsheet ID           | [ADR-004](adr/ADR-004-multi-data-store-adapters.md)                                                         |
| Data store (v2)      | PostgreSQL                                        | Shared schema, `user_id` scoping  | [ADR-004](adr/ADR-004-multi-data-store-adapters.md), [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) |
| Auth                 | Clerk (or Auth0) behind `IAuthProvider` interface | Swappable via adapter             | [ADR-005](adr/ADR-005-authentication-strategy.md)                                                           |
| REST + GraphQL       | Dual transport                                    | Same service layer, two protocols | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md)                                                   |
| Web frontend         | Next.js App Router                                | React Server Components           | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md)                                                    |
| Mobile (v1)          | React Native (Expo)                               | Shared logic with web             | [ADR-008](adr/ADR-008-mobile-strategy.md)                                                                   |
| Mobile (v2)          | Native Kotlin (Jetpack Compose)                   | A/B tested against RN             | [ADR-008](adr/ADR-008-mobile-strategy.md)                                                                   |
| Analytics            | Firebase Analytics                                | Shared event taxonomy             | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md)                                                          |
| A/B testing          | Optimizely                                        | Both RN and Kotlin SDKs           | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md)                                                          |
| API server           | NestJS (primary) + Express (legacy comparison)    | Same core, different wiring       | [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md)                                                     |
| Primary infra        | GKE Autopilot + Helm                              | Kubernetes-native                 | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md)                                               |
| Comparison infra     | Google Cloud Run                                  | Same container image              | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md)                                               |
| IaC                  | Terraform                                         | Shared across both targets        | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md)                                               |

---

## Architecture Decision Records

| #                                                             | Title                                                         | Status   |
| ------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| [ADR-001](adr/ADR-001-monorepo-structure.md)                  | Monorepo Structure with Turborepo                             | Accepted |
| [ADR-002](adr/ADR-002-ports-and-adapters.md)                  | Hexagonal Architecture (Ports and Adapters)                   | Accepted |
| [ADR-003](adr/ADR-003-per-user-data-store-config.md)          | Per-User Data Store Configuration                             | Accepted |
| [ADR-004](adr/ADR-004-multi-data-store-adapters.md)           | Multi-Data-Store Adapter Strategy                             | Accepted |
| [ADR-005](adr/ADR-005-authentication-strategy.md)             | Authentication Strategy                                       | Accepted |
| [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md)     | Dual Transport Layer — REST and GraphQL                       | Accepted · GraphQL not implemented |
| [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md)      | Next.js App Router for Web Frontend                           | Accepted |
| [ADR-008](adr/ADR-008-mobile-strategy.md)                     | Mobile Client Strategy — React Native to Native Kotlin        | Accepted |
| [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Infrastructure — GKE Autopilot Primary, Cloud Run Comparison  | Accepted · 90/10 split not wired |
| [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md)        | Multi-Tenancy Data Isolation Strategy                         | Accepted · RLS implemented ([#511](https://github.com/merickvaughn/lifting-logbook/issues/511)) |
| [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md)       | API Server — NestJS Primary with Express Legacy Comparison    | Accepted |
| [ADR-012](adr/ADR-012-analytics-and-ab-testing.md)            | Analytics and A/B Testing — Firebase Analytics and Optimizely | Accepted |
| [ADR-013](adr/ADR-013-testing-strategy.md)                    | Testing Strategy                                              | Accepted |
| [ADR-014](adr/ADR-014-credential-encryption-at-rest.md)       | Credential Encryption at Rest                                 | Accepted |
| [ADR-015](adr/ADR-015-graphql-dataloader-design.md)           | GraphQL DataLoader Design                                     | Accepted · deferred (no GraphQL yet) |
| [ADR-016](adr/ADR-016-cycle-planning-agent.md)                | Cycle Planning Agent                                          | Accepted |
| [ADR-017](adr/ADR-017-training-max-history-table.md)          | Training Max History — Dedicated Table vs. Derived            | Accepted |
| [ADR-018](adr/ADR-018-observability-stack.md)                 | Observability Stack — OpenTelemetry + Grafana Cloud           | Accepted |
| [ADR-019](adr/ADR-019-slo-methodology.md)                    | SLO Methodology — Burn-Rate Alerting over Threshold Alerting  | Accepted |
| [ADR-020](adr/ADR-020-tail-based-sampling-policy.md)         | Tail-Based Sampling Policy — Errors Always, Slow Always, 20% Clean | Accepted |
| [ADR-021](adr/ADR-021-no-test-tracing.md)                    | No OTel Tracing in Test Environment                                 | Accepted |
| [ADR-022](adr/ADR-022-monorepo-docker-build-strategy.md)     | Monorepo Docker Build Strategy — Full Copy Over Turbo Prune         | Accepted |
| [ADR-023](adr/ADR-023-staging-integration-test-design.md)   | Staging Integration Test Design                                     | Accepted |
| [ADR-024](adr/ADR-024-prisma-otel-sdk-override.md)          | Prisma OTel SDK Version Conflict — postinstall Cleanup              | Accepted |
| [ADR-025](adr/ADR-025-web-image-per-env-build.md)           | Per-Environment Web Image Build                                     | Superseded by ADR-028 |
| [ADR-026](adr/ADR-026-ci-action-version-pinning.md)         | CI Action Version Pinning                                           | Accepted |
| [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md)        | Database Migrations via In-VPC Cloud Run Job in the Deploy Pipeline | Accepted |
| [ADR-028](adr/ADR-028-web-runtime-public-config.md)         | Runtime Injection of apps/web Public Config                         | Accepted |
| [ADR-029](adr/ADR-029-per-env-artifact-registry-push.md)    | Per-Environment Artifact Registry Push                              | Accepted |
| [ADR-030](adr/ADR-030-github-merge-queue-adoption.md)       | GitHub Merge Queue Adoption                                         | Accepted |
| [ADR-031](adr/ADR-031-mandatory-review-gate.md)             | Mandatory Review Gate via GitHub Required Status Check              | Accepted |
| [ADR-032](adr/ADR-032-cloud-run-api-public-invoker.md)      | API Cloud Run Service Is Publicly Invokable; Clerk Auth Is the Real Boundary | Accepted |
| [ADR-033](adr/ADR-033-log-header-allowlist.md)             | Log Header Redaction Is an Allowlist (Redact-by-Default)            | Accepted |
| [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md)  | Edge Rate Limiting for the Unauthenticated `/api/client-errors` Endpoint (Cloud Armor) | Accepted |
| [ADR-035](adr/ADR-035-client-side-rest-timer-state.md)      | The Rest Timer Keeps Its State Client-Side, on the Wall Clock       | Accepted |

---

## Observability & On-Call

New to the logs, traces, dashboards, or on-call rotation? Start with the
[**Observability & On-Call onboarding guide**](operations/observability-onboarding.md) — it
sequences the runbooks below in reading order and explains what the signals mean.

## Runbooks

| Runbook | Covers |
|---------|--------|
| [Observability](runbooks/observability.md) | Local stack startup, Grafana dashboards, trace queries, log↔trace correlation, alert rules + notification routing + silencing, Grafana Cloud credential wiring |
| [Checking the deployed version](runbooks/checking-deployed-version.md) | Confirming what commit is live in staging/production via `/version` + `check-deployed-version.sh` |
| [API 5xx surge](runbooks/api-5xx-surge.md) | `APIRouteHighErrorRate` / `APIHighErrorRate` alert response — SEV2 |
| [Database unreachable](runbooks/database-unreachable.md) | DB connection error triage — SEV1 |
| [Auth provider outage](runbooks/auth-provider-outage.md) | 401/403 surge + Clerk status incident — SEV2 |
| [Deploy regression rollback](runbooks/deploy-regression-rollback.md) | Error rate spike correlated with a recent deploy — SEV2 |

---

## Feature Design Documents

Design, proposal, and prototype artifacts live under three sibling directories:

| Directory | Purpose |
|-----------|---------|
| [`docs/design/`](design/) | Integration design docs: data model, API contracts, algorithm pseudo-code, testing strategy |
| [`docs/proposals/`](proposals/) | Feature proposals created via `/propose`: problem statement, acceptance criteria, phased roadmap |
| [`docs/mockups/`](mockups/) | Interactive HTML prototypes for UI features |

Proposals link to their corresponding design doc and mockup. See [`docs/proposals/README.md`](proposals/README.md) for the proposal lifecycle (`draft` → `accepted` → `shipped`).

---

## Architecture Diagrams

Visual representations of the system are in [`docs/diagrams/`](diagrams/):

| Diagram | What it shows |
|---------|--------------|
| [Hexagonal Architecture](diagrams/hexagonal-architecture.md) | `packages/core` at the center, port interfaces, and adapter implementations |
| [Package Dependencies](diagrams/package-dependencies.md) | Compile-time dependency graph across all monorepo packages and apps |
| [Deployment Topology](diagrams/deployment-topology.md) | GKE Autopilot vs. Cloud Run traffic split, shared infrastructure, CI/CD |
| [Data Flow](diagrams/data-flow.md) | Request path: client → transport → domain service → repository adapter → data store |

---

## Product Requirements

See [PRD.md](PRD.md) for the lightweight product requirements document: user personas,
jobs-to-be-done, non-goals, and v1.0 success metrics.

---

## User Guide

See [user-guide.md](user-guide.md) for an end-user walkthrough of every screen in the
web app: onboarding, cycle dashboard, workout logging, training maxes, strength goals,
schedule, history, programs, and a glossary of lifting terminology.

---

## Compliance Awareness

This application currently handles personal fitness data for a single user or small group of
known users. It is not subject to HIPAA or GDPR in its current form. However, architectural
decisions explicitly account for what would need to change if compliance requirements were
introduced. See [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) for a detailed treatment
of the compliance implications of each data isolation strategy.

---

## Security Review

A pre-ship security review checklist is maintained at [`docs/security-review-checklist.md`](security-review-checklist.md).

The checklist is gated on the v0.2 milestone (first authenticated endpoint). It covers: JWT token handling, session storage, multi-tenancy data isolation, input validation, OWASP Top 10 applicability, security headers, and dependency audit. All findings must be resolved or explicitly risk-accepted before v0.2 is closed.
