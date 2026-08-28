# ADR Reference Index

Consolidated list of all external sources cited across the Architecture Decision Records.
Each entry links back to the ADR where it is discussed and provides a brief description of why the source is relevant.

---

## Architectural Patterns

| Source | Cited In | Relevance |
|---|---|---|
| [Alistair Cockburn — Hexagonal Architecture (2005)](https://alistair.cockburn.us/hexagonal-architecture/) | [ADR-002](adr/ADR-002-ports-and-adapters.md) | Origin of the Ports and Adapters pattern; the port/adapter vocabulary and dependency rule used throughout the codebase come from here. |
| [Robert C. Martin — The Clean Architecture (2012)](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) | [ADR-002](adr/ADR-002-ports-and-adapters.md) | Generalises the dependency inversion principle into the "dependency rule": source-code dependencies must point inward toward higher-level policy. |
| [Martin Fowler — Inversion of Control Containers and the Dependency Injection Pattern](https://martinfowler.com/articles/injection.html) | [ADR-002](adr/ADR-002-ports-and-adapters.md), [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | Background on constructor injection and IoC containers; directly relevant to how NestJS wires adapters to ports. |

---

## Monorepo Tooling

| Source | Cited In | Relevance |
|---|---|---|
| [Turborepo — Getting Started](https://turbo.build/repo/docs) | [ADR-001](adr/ADR-001-monorepo-structure.md) | Official Turborepo docs; covers caching model, pipeline configuration, and workspace setup. |
| [Turborepo — `turbo prune`](https://turbo.build/repo/docs/reference/prune) | [ADR-001](adr/ADR-001-monorepo-structure.md), [ADR-022](adr/ADR-022-monorepo-docker-build-strategy.md) | Pruning the monorepo for Docker builds; ADR-022 records why this approach was abandoned in favour of copying the full repo. |
| [Turborepo — Docker guide](https://turbo.build/repo/docs/guides/tools/docker) | [ADR-022](adr/ADR-022-monorepo-docker-build-strategy.md) | Canonical Turborepo Docker build guide; documents the `turbo prune --docker` pattern and its assumptions about workspace layout. |
| [npm workspaces — Hoisting behaviour](https://docs.npmjs.com/cli/v10/using-npm/workspaces#installing-workspaces) | [ADR-022](adr/ADR-022-monorepo-docker-build-strategy.md) | Documents when npm hoists workspace packages to root `node_modules` vs. leaving them in workspace-local `node_modules`; explains why the runner stage must copy both locations. |
| [npm Workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces) | [ADR-001](adr/ADR-001-monorepo-structure.md) | The npm workspace protocol enabling `"@logbook/core": "*"` inter-package references. |
| [Nx — Getting Started](https://nx.dev/getting-started/intro) | [ADR-001](adr/ADR-001-monorepo-structure.md) | Primary alternative to Turborepo; ruled out as over-configured for this scale. |

---

## API Server

| Source | Cited In | Relevance |
|---|---|---|
| [NestJS — Documentation](https://docs.nestjs.com) | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md), [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | Official NestJS docs; covers modules, providers, controllers, guards, interceptors, and exception filters. |
| [NestJS — Dependency Injection](https://docs.nestjs.com/fundamentals/dependency-injection) | [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | The DI container mechanics (`@Injectable`, `@Inject`) that replace Express's manual wiring. |
| [NestJS — Performance (Fastify adapter)](https://docs.nestjs.com/techniques/performance) | [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | Documents the `FastifyAdapter`; explains the platform-agnostic adapter API and how to swap from the default Express adapter. |
| [NestJS — GraphQL (Code First)](https://docs.nestjs.com/graphql/quick-start) | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md), [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | Code-first approach using TypeScript decorators to generate the GraphQL SDL alongside REST controllers in the same module. |
| [Fastify — Documentation](https://fastify.dev/docs/latest/) | [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | The underlying HTTP framework; covers request/response lifecycle, plugins, and schema-based validation. |
| [Fastify — Benchmarks](https://fastify.dev/benchmarks/) | [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | Benchmark data supporting the ~2× throughput advantage over Express cited in the Rationale. |
| [Express.js — Routing](https://expressjs.com/en/guide/routing.html) | [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | The manual routing approach (`app.get()`) used in the legacy `apps/api-legacy` implementation. |

---

## Transport Layer (REST + GraphQL)

| Source | Cited In | Relevance |
|---|---|---|
| [GraphQL Specification (October 2021)](https://spec.graphql.org/October2021/) | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md) | Normative language and type system specification for GraphQL. |
| [graphql/dataloader — README](https://github.com/graphql/dataloader#readme) | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md), [ADR-015](adr/ADR-015-graphql-dataloader-design.md) | The batching and caching utility for solving the N+1 problem in nested GraphQL resolvers; ADR-015 documents the required per-request instantiation pattern. |
| [Apollo Client — Documentation](https://www.apollographql.com/docs/react/) | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md) | GraphQL client library referenced in the REST vs. GraphQL caching comparison. |
| [NestJS — Injection Scopes](https://docs.nestjs.com/fundamentals/injection-scopes) | [ADR-015](adr/ADR-015-graphql-dataloader-design.md) | Documents `Scope.REQUEST`, scope propagation up the dependency tree, and the performance implications of request-scoped providers; the mechanism used to enforce per-request DataLoader lifecycle. |

---

## Authentication

| Source | Cited In | Relevance |
|---|---|---|
| [RFC 6749 — OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749) | [ADR-005](adr/ADR-005-authentication-strategy.md) | Core OAuth 2.0 specification; defines the authorisation code flow used by Clerk and Auth0. |
| [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) | [ADR-005](adr/ADR-005-authentication-strategy.md) | OIDC identity layer on top of OAuth 2.0; defines the ID token, `sub` claim, and UserInfo endpoint. |
| [RFC 7636 — PKCE](https://datatracker.ietf.org/doc/html/rfc7636) | [ADR-005](adr/ADR-005-authentication-strategy.md) | Proof Key for Code Exchange; prevents authorisation code interception in mobile and SPA flows. |
| [OASIS SAML 2.0 Core Specification](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf) | [ADR-005](adr/ADR-005-authentication-strategy.md) | Enterprise SSO standard referenced in Future Considerations for B2B extension scenarios. |
| [Clerk — Documentation](https://clerk.com/docs) | [ADR-005](adr/ADR-005-authentication-strategy.md) | Official Clerk docs; covers Next.js SDK, JWT verification, and organisation/session management. |
| [Clerk — Next.js SDK](https://clerk.com/docs/references/nextjs/overview) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | The `@clerk/nextjs` middleware-based auth integration for the App Router. |
| [Auth0 — Documentation](https://auth0.com/docs) | [ADR-005](adr/ADR-005-authentication-strategy.md) | Official Auth0 docs; the primary alternative to Clerk. |

---

## Web Frontend

| Source | Cited In | Relevance |
|---|---|---|
| [Next.js — App Router Documentation](https://nextjs.org/docs/app) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | Official App Router docs; covers Server Components, Client Components, routing, layouts, and Suspense streaming. |
| [React — Server Components](https://react.dev/reference/rsc/server-components) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | React core team reference for RSC; the model the App Router is built on. |
| [Next.js — Loading UI and Streaming](https://nextjs.org/docs/app/building-your-application/routing/loading-ui-and-streaming) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | How Suspense boundaries and `loading.tsx` enable progressive rendering of data-heavy pages. |
| [Next.js — fetch API reference](https://nextjs.org/docs/app/api-reference/functions/fetch) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | Documents the `cache` and `next.revalidate` options for `fetch()` in Server Components; authoritative reference for the explicit cache semantics required by the project coding standard. |
| [React Testing Library](https://testing-library.com/docs/react-testing-library/intro/) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | The testing approach for Client Components cited in the Consequences section. |
| [Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/) | [ADR-035](adr/ADR-035-client-side-rest-timer-state.md) | W3C spec; §3.3 defines the release-on-hidden behaviour that makes re-acquisition on `visibilitychange` mandatory rather than optional. |
| [MDN — `OscillatorNode`](https://developer.mozilla.org/en-US/docs/Web/API/OscillatorNode) | [ADR-035](adr/ADR-035-client-side-rest-timer-state.md) | The Web Audio primitive behind the end-of-phase beep, and the user-gesture requirement for resuming a suspended `AudioContext`. |
| [MDN — `Navigator.vibrate()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate) | [ADR-035](adr/ADR-035-client-side-rest-timer-state.md) | Vibration-pattern support and the desktop no-op behaviour the alert wrapper relies on. |
| [WAI-ARIA 1.2 — `timer` role](https://www.w3.org/TR/wai-aria-1.2/#timer) | [ADR-035](adr/ADR-035-client-side-rest-timer-state.md) | Defines `timer` as a live region with an implicit `aria-live="off"` — why the 200 ms countdown does not announce on every tick. |
| [WAI-ARIA APG — Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | [ADR-035](adr/ADR-035-client-side-rest-timer-state.md) | Focus-management and Escape behaviour the expanded timer sheet implements. |

---

## Data Layer

| Source | Cited In | Relevance |
|---|---|---|
| [Google Sheets API v4 — Reference](https://developers.google.com/sheets/api/reference/rest) | [ADR-004](adr/ADR-004-multi-data-store-adapters.md) | The API used by the Sheets adapter; documents range notation, batch operations, and value rendering modes. |
| [Google Sheets API — Usage Limits](https://developers.google.com/sheets/api/limits) | [ADR-004](adr/ADR-004-multi-data-store-adapters.md) | The 100 requests/100 seconds per-user quota cited in the Consequences section. |
| [googleapis npm package](https://www.npmjs.com/package/googleapis) | [ADR-004](adr/ADR-004-multi-data-store-adapters.md) | The Node.js client library wrapping the Sheets API. |
| [Prisma ORM — Getting Started](https://www.prisma.io/docs/getting-started) | [ADR-004](adr/ADR-004-multi-data-store-adapters.md) | The ORM for the Postgres adapter; provides schema definition, type-safe query building, and migrations. |
| [Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate/getting-started) | [ADR-004](adr/ADR-004-multi-data-store-adapters.md) | The migration system for evolving the Postgres schema. |
| [Prisma Client — Middleware](https://www.prisma.io/docs/orm/prisma-client/client-extensions/middleware) | [ADR-003](adr/ADR-003-per-user-data-store-config.md) | How Prisma middleware injects `app.current_user_id` before each query to enforce per-user scoping. |
| [PostgreSQL — JSON Types (JSONB)](https://www.postgresql.org/docs/current/datatype-json.html) | [ADR-003](adr/ADR-003-per-user-data-store-config.md) | The `JSONB` column type used for `adapter_config`; covers indexing, operators, and storage behaviour. |
| [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) | The RLS feature used for database-level isolation; `ALTER TABLE ... ENABLE`/`FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, and the superuser/`BYPASSRLS` exemption. |
| [PostgreSQL — Configuration Settings Functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET) | [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) | `set_config(_, _, true)` / `current_setting(_, true)` — how `app.current_user_id` is set transaction-locally and read fail-closed in policies. |
| [nestjs-cls](https://papooch.github.io/nestjs-cls/) | [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) | AsyncLocalStorage-backed CLS carrying the per-request RLS transaction client to the repository factory. |
| [PostgreSQL — Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) | [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) | The schema-per-tenant alternative to shared-schema; covers `CREATE SCHEMA` and `search_path`. |
| [PgBouncer — Usage](https://www.pgbouncer.org/usage.html) | [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) | Connection pooler cited in the schema-per-tenant alternative discussion (`search_path` management). |

---

## Infrastructure

| Source | Cited In | Relevance |
|---|---|---|
| [GKE Autopilot — Overview](https://cloud.google.com/kubernetes-engine/docs/concepts/autopilot-overview) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Documents the Autopilot node management model, pod-based billing, and resource constraints. |
| [Google Cloud Run — Overview](https://cloud.google.com/run/docs/overview/what-is-cloud-run) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Documents scale-to-zero behaviour, cold start characteristics, and request-based billing. |
| [Terraform — Documentation](https://developer.hashicorp.com/terraform/docs) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | IaC tool used to provision GKE, Cloud Run, VPC, and load balancer resources. |
| [Helm — Documentation](https://helm.sh/docs/) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Kubernetes package manager for `charts/api` and `charts/web`; covers chart structure, values files, and `helm upgrade`. |
| [Kubernetes — Horizontal Pod Autoscaler](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | The HPA configuration shown in the Decision section (`minReplicas: 2`, `maxReplicas: 10`, CPU target 70%). |
| [Google Cloud Load Balancing — HTTPS](https://cloud.google.com/load-balancing/docs/https) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | The load balancer used for 90/10 traffic splitting between GKE and Cloud Run. |
| [Google Artifact Registry — Overview](https://cloud.google.com/artifact-registry/docs/overview) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Container registry where Docker images are pushed by CI/CD. |
| [k6 — Load Testing Documentation](https://grafana.com/docs/k6/latest/) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Load testing tool used for the scale-out time metric in the A/B infrastructure comparison. |
| [Google Cloud KMS — Envelope Encryption](https://cloud.google.com/kms/docs/envelope-encryption) | [ADR-003](adr/ADR-003-per-user-data-store-config.md), [ADR-014](adr/ADR-014-credential-encryption-at-rest.md) | Encryption strategy for the `adapter_config` column; ADR-014 specifies the full KEK/DEK hierarchy, encrypt/decrypt flow, and re-encryption procedure. |
| [Google Cloud Run — Authentication overview](https://cloud.google.com/run/docs/authenticating/overview) | [ADR-032](adr/ADR-032-cloud-run-api-public-invoker.md) | The IAM-invoker model the API service partially opts out of, and the public-invocation pattern it opts into instead. |
| [Google Cloud Run — Invoking a public (unauthenticated) service](https://cloud.google.com/run/docs/authenticating/public) | [ADR-032](adr/ADR-032-cloud-run-api-public-invoker.md) | The specific `allUsers` grant applied to the API service, mirroring the web service's existing configuration. |
| [MDN — CORS: Preflighted requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS#preflighted_requests) | [ADR-032](adr/ADR-032-cloud-run-api-public-invoker.md) | Explains why a CORS preflight `OPTIONS` request cannot carry the actual request's custom auth headers — the reason no client-side header change could work around the Cloud Run IAM gate. |
| [NestJS — CORS](https://docs.nestjs.com/security/cors) | [ADR-032](adr/ADR-032-cloud-run-api-public-invoker.md) | `app.enableCors()`, the application-layer control added so the API answers the browser's preflight after Cloud Run stops blocking it. |
| [`@fastify/cors`](https://github.com/fastify/fastify-cors) | [ADR-032](adr/ADR-032-cloud-run-api-public-invoker.md) | The CORS plugin NestJS's Fastify adapter registers under the hood for `enableCors()`; supports the origin allowlist used in `cors.config.ts`. |
| [Google Cloud Armor — Rate limiting overview](https://cloud.google.com/armor/docs/rate-limiting-overview) | [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md) | `throttle` vs. `rate_based_ban`, `enforce_on_key`, and threshold/interval semantics; the mechanism the `/api/client-errors` rate-limit rule uses. |
| [Google Cloud — External Application Load Balancer with Cloud Run (serverless NEG)](https://cloud.google.com/load-balancing/docs/https/setting-up-https-serverless) | [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md) | The serverless-NEG external HTTPS ALB topology provisioned in `edge-load-balancer.tf`, and where the Cloud Armor policy attaches. |
| [Google Cloud — Serverless network endpoint groups (NEGs) overview](https://cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts) | [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md) | How a Cloud Run service is placed behind an external ALB backend service — the substrate Cloud Armor rate limiting requires. |
| [Google Cloud Run — Restricting network ingress](https://cloud.google.com/run/docs/securing/ingress) | [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md) | The `INTERNAL_AND_CLOUD_LOAD_BALANCING` ingress setting used to stop the `run.app` URL bypassing the load balancer's rate limit; also why a Cloud Run domain mapping is incompatible with that mode (2026-07-12 amendment). |
| [Google Cloud Certificate Manager — DNS authorizations](https://cloud.google.com/certificate-manager/docs/dns-authorizations) | [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md) | The per-domain `_acme-challenge` CNAME validation that lets the managed cert reach `ACTIVE` before the apex/www DNS is cut to the LB — the zero-downtime mechanism of the 2026-07-12 amendment. |
| [Google Cloud Certificate Manager — Deploy a Google-managed certificate with DNS authorization](https://cloud.google.com/certificate-manager/docs/deploy-google-managed-dns-auth) | [ADR-034](adr/ADR-034-edge-rate-limiting-client-errors.md) | The certificate → certificate map → target HTTPS proxy attachment path `edge-load-balancer.tf` provisions (replacing the classic `ssl_certificates` list). |

---

## Mobile

| Source | Cited In | Relevance |
|---|---|---|
| [React Native — Getting Started](https://reactnative.dev/docs/getting-started) | [ADR-008](adr/ADR-008-mobile-strategy.md) | Official React Native documentation. |
| [Expo — Documentation](https://docs.expo.dev) | [ADR-008](adr/ADR-008-mobile-strategy.md) | Expo managed workflow used in Phase 1; covers project structure, native modules, and OTA updates. |
| [Expo EAS Build](https://docs.expo.dev/build/introduction/) | [ADR-008](adr/ADR-008-mobile-strategy.md) | Cloud build service producing Android APKs without a local native toolchain. |
| [React Navigation — Getting Started](https://reactnavigation.org/docs/getting-started) | [ADR-008](adr/ADR-008-mobile-strategy.md) | Navigation library used in the React Native client. |
| [Jetpack Compose — Documentation](https://developer.android.com/develop/ui/compose/documentation) | [ADR-008](adr/ADR-008-mobile-strategy.md) | Native Android UI framework used in the Kotlin (Phase 2) client. |
| [Kotlin — Documentation](https://kotlinlang.org/docs/home.html) | [ADR-008](adr/ADR-008-mobile-strategy.md) | Official Kotlin language reference. |
| [Google Play — Manage Tracks](https://support.google.com/googleplay/android-developer/answer/9844487) | [ADR-008](adr/ADR-008-mobile-strategy.md) | How internal, closed testing, and production tracks work; the mechanism for deploying Phase 1 and Phase 2 builds simultaneously. |

---

## Analytics and A/B Testing

| Source | Cited In | Relevance |
|---|---|---|
| [Firebase Analytics — Overview](https://firebase.google.com/docs/analytics) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | Official Firebase Analytics docs; covers event logging, user properties, and audience segmentation. |
| [React Native Firebase — Analytics](https://rnfirebase.io/analytics/usage) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | The `@react-native-firebase/analytics` SDK used in the React Native client. |
| [Firebase Analytics for Android](https://firebase.google.com/docs/analytics/get-started?platform=android) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | The `com.google.firebase:firebase-analytics` SDK used in the Kotlin client. |
| [Firebase Crashlytics](https://firebase.google.com/docs/crashlytics) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | Crash reporting SDK used in both clients; crash-free session rate is a primary A/B comparison metric. |
| [Firebase Performance Monitoring](https://firebase.google.com/docs/perf-mon) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | Screen render time and app startup time SDK cited in the A/B metrics table. |
| [Firebase — BigQuery Export](https://firebase.google.com/docs/projects/bigquery-export) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | How Firebase Analytics data is streamed to BigQuery for deeper analysis. |
| [Optimizely Feature Experimentation — Welcome](https://docs.developers.optimizely.com/feature-experimentation/docs/welcome) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | Official Optimizely docs; covers experiment configuration, variation assignment, and event tracking. |
| [Optimizely — JavaScript (React) SDK](https://docs.developers.optimizely.com/feature-experimentation/docs/javascript-react-sdk) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | The `@optimizely/react-sdk` used in the React Native client. |
| [Optimizely — Android SDK](https://docs.developers.optimizely.com/feature-experimentation/docs/android-sdk) | [ADR-012](adr/ADR-012-analytics-and-ab-testing.md) | The `com.optimizely.sdk:android-sdk` used in the Kotlin client. |

---

## Compliance

| Source | Cited In | Relevance |
|---|---|---|
| [GDPR — Article 17: Right to Erasure](https://gdpr-info.eu/art-17-gdpr/) | [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) | The regulatory requirement driving the erasure complexity comparison between shared-schema and schema-per-tenant strategies. |
| [HHS — HIPAA Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/index.html) | [ADR-010](adr/ADR-010-multi-tenancy-data-isolation.md) | US healthcare data protection regulation discussed in the HIPAA section; relevant if the application is extended to clinical contexts. |

---

## Security Standards

| Source | Cited In | Relevance |
|---|---|---|
| [Google Cloud KMS — Key Rotation](https://cloud.google.com/kms/docs/key-rotation) | [ADR-014](adr/ADR-014-credential-encryption-at-rest.md) | Automatic rotation scheduling, prior key version behaviour after rotation, and audit logging for version-level decrypt calls used in the re-encryption procedure. |
| [Google Tink — AES-GCM AEAD](https://developers.google.com/tink/aead) | [ADR-014](adr/ADR-014-credential-encryption-at-rest.md) | Recommended implementation library for AEAD encryption on GCP; covers AES-256-GCM key generation, encrypt/decrypt API, and key rotation via keyset handles. |
| [NIST SP 800-38D — Recommendation for Block Cipher Modes of Operation: GCM and GMAC](https://csrc.nist.gov/publications/detail/sp/800-38d/final) | [ADR-014](adr/ADR-014-credential-encryption-at-rest.md) | NIST normative recommendation for GCM mode; documents the 12-byte nonce requirement and authentication tag validation used for `config_ciphertext` integrity. |

---

## Security Review

References from [`docs/security-review-checklist.md`](security-review-checklist.md).

| Source | Cited In | Relevance |
|---|---|---|
| [OWASP Top 10 (2021)](https://owasp.org/Top10/) | [Security Review Checklist](security-review-checklist.md) | The ten most critical web application security risks; used as the framework for the OWASP applicability section. |
| [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) | [Security Review Checklist](security-review-checklist.md) | Practical guidance for implementing and reviewing authentication mechanisms; informs the token handling and session checklist items. |
| [OWASP SQL Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) | [Security Review Checklist](security-review-checklist.md) | Parameterised query requirements referenced in the A03 (Injection) OWASP applicability row. |
| [NestJS — Security](https://docs.nestjs.com/security/helmet) | [Security Review Checklist](security-review-checklist.md) | Official NestJS docs covering Helmet, CORS, rate limiting, and CSRF protection; informs Section 6 (Security Headers and Transport). |
| [Clerk — Security](https://clerk.com/docs/security/overview) | [Security Review Checklist](security-review-checklist.md) | Clerk's security model; documents token verification, session management, and compliance posture. |

---

## LLM Integration

| Source | Cited In | Relevance |
|---|---|---|
| [Anthropic — Tool Use (Function Calling)](https://docs.anthropic.com/en/docs/tool-use) | [ADR-016](adr/ADR-016-cycle-planning-agent.md) | The Anthropic guide to tool use with the Messages API; documents the tool schema format, the agentic loop pattern, and the `propose_<output>` tool pattern for structured output. |
| [Anthropic Node.js SDK (`@anthropic-ai/sdk`)](https://github.com/anthropics/anthropic-sdk-node) | [ADR-016](adr/ADR-016-cycle-planning-agent.md) | The SDK used in the cycle planning adapter; documents `client.messages.create()` and the `tool_use` / `tool_result` message block types. |
| [Anthropic — Model Deprecation Policy](https://docs.anthropic.com/en/docs/deprecations) | [ADR-016](adr/ADR-016-cycle-planning-agent.md) | Anthropic's published model deprecation timeline; the `CYCLE_AGENT_MODEL` env var must be kept current as model versions age out. |

---

## Data Design

| Source | Cited In | Relevance |
|---|---|---|
| [Prisma — `createMany`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany) | [ADR-017](adr/ADR-017-training-max-history-table.md) | Batch insert API used by `PrismaTrainingMaxHistoryRepository.appendHistoryEntries`. |
| [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) | [ADR-017](adr/ADR-017-training-max-history-table.md) | Background pattern: storing state changes as a sequence of events rather than deriving history post-hoc from current state. The `training_max_history` table is a lightweight application of this principle. |

---

## Observability

| Source | Cited In | Relevance |
|---|---|---|
| [OpenTelemetry — Specification](https://opentelemetry.io/docs/specs/otel/) | [ADR-018](adr/ADR-018-observability-stack.md) | Normative OTel protocol and SDK contract; the wire format every exporter and collector implements. |
| [OpenTelemetry — JavaScript / Node.js SDK](https://opentelemetry.io/docs/languages/js/) | [ADR-018](adr/ADR-018-observability-stack.md) | The `@opentelemetry/sdk-node` package documentation used by `apps/api/src/otel.ts`. |
| [OpenTelemetry — Collector](https://opentelemetry.io/docs/collector/) | [ADR-018](adr/ADR-018-observability-stack.md) | Collector receiver/processor/exporter pipeline model; supports the DaemonSet vs. sidecar topology decision. |
| [Grafana Cloud — Send data via OTLP](https://grafana.com/docs/grafana-cloud/send-data/otlp/) | [ADR-018](adr/ADR-018-observability-stack.md) | Ingestion contract for the chosen backend; defines the OTLP endpoint, authentication model, and per-signal limits. |
| [Grafana Tempo — Documentation](https://grafana.com/docs/tempo/latest/) | [ADR-018](adr/ADR-018-observability-stack.md) | The trace store; covers OTLP ingest and Grafana integration used by the local docker-compose verification path. |
| [Grafana Loki — Documentation](https://grafana.com/docs/loki/latest/) | [ADR-018](adr/ADR-018-observability-stack.md) | The log store; covers LogQL and the `traceID` derived field used to jump from log lines to traces. |
| [Grafana Mimir — Documentation](https://grafana.com/docs/mimir/latest/) | [ADR-018](adr/ADR-018-observability-stack.md) | The Prometheus-compatible metrics store; alert rule format is identical to upstream Prometheus. |
| [W3C — Trace Context](https://www.w3.org/TR/trace-context/) | [ADR-018](adr/ADR-018-observability-stack.md), [ADR-033](adr/ADR-033-log-header-allowlist.md) | The `traceparent` / `tracestate` HTTP header format used to propagate trace context from `apps/web` to `apps/api`; ADR-033 allowlists both for logging as non-credential correlation IDs. |
| [Prisma — OpenTelemetry tracing](https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/opentelemetry-tracing) | [ADR-018](adr/ADR-018-observability-stack.md) | Documents `previewFeatures = ["tracing"]` in `schema.prisma`, required for `@prisma/instrumentation` to attach. |
| [`nestjs-pino` README](https://github.com/iamolegga/nestjs-pino) | [ADR-018](adr/ADR-018-observability-stack.md) | The pino integration for NestJS; documents the `formatters` hook used to inject `trace_id` / `span_id`. |
| [NestJS — Techniques: Logger](https://docs.nestjs.com/techniques/logger) | [ADR-018](adr/ADR-018-observability-stack.md) | Official NestJS guide for replacing the built-in logger, which is what `nestjs-pino` does. |
| [Pino — Documentation](https://getpino.io/) | [ADR-018](adr/ADR-018-observability-stack.md) | The underlying JSON logger; covers serialization performance and the formatter API. |
| [`@vercel/otel`](https://vercel.com/docs/observability/otel-overview) | [ADR-018](adr/ADR-018-observability-stack.md) | Next.js's officially-recommended OTel wrapper; integrates with Next.js's instrumentation hook. |
| [Next.js — OpenTelemetry](https://nextjs.org/docs/app/building-your-application/optimizing/open-telemetry) | [ADR-018](adr/ADR-018-observability-stack.md) | The instrumentation API in Next.js 16 used by `apps/web/instrumentation.ts`. |
| [Google SRE Book — Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) | [ADR-018](adr/ADR-018-observability-stack.md) | The RED/USE framing the initial alert rules are built on. |
| [Prometheus — Alerting Rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) | [ADR-018](adr/ADR-018-observability-stack.md) | The alert rule syntax used in `infra/observability/alerts/api.yaml`. |
| [CNCF — OpenTelemetry project page](https://www.cncf.io/projects/opentelemetry/) | [ADR-018](adr/ADR-018-observability-stack.md) | Supports the "de facto standard" framing of the OTel decision. |
| [Google SRE Workbook — Chapter 5: Alerting on SLOs](https://sre.google/workbook/alerting-on-slos/) | [ADR-019](adr/ADR-019-slo-methodology.md) | Canonical burn-rate alerting methodology; defines the burn-rate concept, two-window strategy, and the 14×/6×/3× rate thresholds. |
| [Google SRE Book — Chapter 4: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/) | [ADR-019](adr/ADR-019-slo-methodology.md) | Foundational SLO framing: SLI → SLO → error budget chain, measurement window semantics, and conservative target rationale. |
| [Google SRE Book — Chapter 6: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) | [ADR-018](adr/ADR-018-observability-stack.md), [ADR-019](adr/ADR-019-slo-methodology.md) | The four golden signals and symptom-vs-cause alert framing. |
| [Prometheus — Recording Rules](https://prometheus.io/docs/prometheus/latest/configuration/recording_rules/) | [ADR-019](adr/ADR-019-slo-methodology.md) | Required for efficient evaluation of 28-day burn-rate expressions; authoritative syntax reference. |
| [OpenSLO — Specification](https://openslo.com/) | [ADR-019](adr/ADR-019-slo-methodology.md) | YAML open standard for SLO definition; informs the `docs/operations/slo.md` format. |
| [OpenTelemetry Collector contrib — `tail_sampling` processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/tailsamplingprocessor) | [ADR-020](adr/ADR-020-tail-based-sampling-policy.md) | Authoritative documentation for the `tail_sampling` processor; covers all policy types, `decision_wait` semantics, and known limitations. |
| [OpenTelemetry — Sampling](https://opentelemetry.io/docs/concepts/sampling/) | [ADR-020](adr/ADR-020-tail-based-sampling-policy.md) | Conceptual overview of head-based vs. tail-based sampling; basis for the Rationale framing in ADR-020. |
| [WHATWG Fetch Standard — CORS protocol & the `Origin` header](https://fetch.spec.whatwg.org/#origin-header) | [ADR-020](adr/ADR-020-tail-based-sampling-policy.md) | Primary spec behind the #806 addendum: when browsers attach `Origin` and which requests are CORS-"simple" (no preflight); why `sendBeacon` reaches the sink cross-origin and why the same-origin guard keys on `Origin`. |
| [MDN — `Navigator.sendBeacon()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon) | [ADR-020](adr/ADR-020-tail-based-sampling-policy.md) | The browser API `apps/web` uses to post client errors; its fire-and-forget, unload-surviving, CORS-simple semantics, referenced by the #806 addendum. |
| [npm — `overrides` configuration](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#overrides) | [ADR-024](adr/ADR-024-prisma-otel-sdk-override.md) | Official npm docs for the `overrides` field; covers the scoped `{ "package": { "dep": "version" } }` syntax used to force a single `@opentelemetry/sdk-trace-base` version for `@prisma/instrumentation`. |
| [Prisma — OpenTelemetry tracing](https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/opentelemetry-tracing) | [ADR-024](adr/ADR-024-prisma-otel-sdk-override.md) | Documents `@prisma/instrumentation` setup and the `previewFeatures = ["tracing"]` requirement in `schema.prisma`. |
| [OpenTelemetry JavaScript — Changelog (v2.0)](https://github.com/open-telemetry/opentelemetry-js/blob/main/CHANGELOG.md) | [ADR-024](adr/ADR-024-prisma-otel-sdk-override.md) | Documents the v1 → v2 breaking changes to `sdk-trace-base` that produce the `getActiveSpanProcessor` crash when two SDK versions coexist. |
| [Pino — Redaction](https://getpino.io/#/docs/redaction) | [ADR-033](adr/ADR-033-log-header-allowlist.md) | The `redact.paths` mechanism and its path syntax; establishes that redaction is denylist-only and that wildcards match all keys at a level, not a name pattern — the limitation that motivates the allowlist serializer. |
| [Pino — `serializers` option](https://getpino.io/#/docs/api?id=serializers-object) | [ADR-033](adr/ADR-033-log-header-allowlist.md) | The serializer hook used to filter `req` / `res` headers down to an allowlist before serialization. |
| [pino-std-serializers — README](https://github.com/pinojs/pino-std-serializers#readme) | [ADR-033](adr/ADR-033-log-header-allowlist.md) | `pino.stdSerializers.req` / `.res`, the standard serializers the config runs first and then post-processes to replace `headers` while preserving method / url / statusCode. |
| [OWASP — Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) | [ADR-033](adr/ADR-033-log-header-allowlist.md) | Normative guidance that access tokens, session identifiers, and authorization headers must never be written to logs — the rule ADR-033 enforces by default. |

---

## Deployment Pipeline

| Source | Cited In | Relevance |
|---|---|---|
| [Next.js — Configuring Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables) | [ADR-025](adr/ADR-025-web-image-per-env-build.md), [ADR-028](adr/ADR-028-web-runtime-public-config.md) | Authoritative on `NEXT_PUBLIC_*` build-time inlining; values are inlined into JavaScript sent to the browser and fixed at build time. ADR-025 cites it as the root cause forcing per-env builds; ADR-028 as the constraint the rename works around to inject config at runtime. |
| [Next.js — Route Segment Config: `dynamic`](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#dynamic) | [ADR-028](adr/ADR-028-web-runtime-public-config.md) | `force-dynamic` opts the root layout out of static prerendering so server-side `process.env` reads happen per request rather than being baked at build. |
| [Clerk — `<ClerkProvider>` `publishableKey` prop](https://clerk.com/docs/components/clerk-provider) | [ADR-028](adr/ADR-028-web-runtime-public-config.md) | The publishable key can be passed as a prop (runtime-key pattern) instead of relying on build-time env inlining — the mechanism that unblocks Clerk's synchronous client mount under runtime injection. |
| [OWASP — XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) | [ADR-028](adr/ADR-028-web-runtime-public-config.md) | Rationale for escaping `<` when serializing JSON into an inline `<script>` element (prevents `</script>` breakout), applied defensively in `publicConfigScript`. |
| [Docker — `ARG` and build-time variables](https://docs.docker.com/engine/reference/builder/#arg) | [ADR-025](adr/ADR-025-web-image-per-env-build.md) | Build-arg semantics; a build-arg change invalidates downstream layer cache, which is why the staging and prod web builds re-execute `RUN npx turbo run build` despite sharing the install layers. |
| [Clerk — Publishable Key](https://clerk.com/docs/deployments/clerk-environment-variables#clerk-publishable-key) | [ADR-025](adr/ADR-025-web-image-per-env-build.md) | Documents that the publishable key is environment-bound (one key per Clerk instance) and is required by `<ClerkProvider>` at client mount. |
| [`docker/build-push-action`](https://github.com/docker/build-push-action) | [ADR-025](adr/ADR-025-web-image-per-env-build.md), [ADR-029](adr/ADR-029-per-env-artifact-registry-push.md) | GitHub Action used to invoke `docker build`; `cache-from`/`cache-to: type=gha` semantics for GitHub Actions layer cache reuse. ADR-029 reuses the cached build to push the same image to the prod AR (a cache-resolve + push, not a rebuild). |
| [GitHub — Security hardening for GitHub Actions § Using third-party actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions) | [ADR-026](adr/ADR-026-ci-action-version-pinning.md) | GitHub's guidance on pinning third-party actions to a commit SHA vs. trusting first-party `actions/*` at tag level; the basis for keeping floating major tags. |
| [GitHub — Workflow syntax: `uses`](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idstepsuses) | [ADR-026](adr/ADR-026-ci-action-version-pinning.md) | Defines the `@ref` pinning forms (branch, tag, SHA) and their resolution semantics. |
| [GitHub Changelog — Actions: Node 16 → Node 20](https://github.blog/changelog/2023-09-22-github-actions-transitioning-from-node-16-to-node-20/) | [ADR-026](adr/ADR-026-ci-action-version-pinning.md) | The runner runtime-deprecation mechanism that drives ADR-026's re-audit trigger. |
| [Dependabot — Keeping your actions up to date](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot) | [ADR-026](adr/ADR-026-ci-action-version-pinning.md) | The config required to make a digest-pin strategy maintainable; its absence supports choosing floating tags. |
| [Prisma — Deploying database changes (production & testing)](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production#production-and-testing-environments) | [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md) | Establishes `prisma migrate deploy` as the production/CI command (applies pending migrations, never resets, no prompts); the command the migration job runs. |
| [Prisma — CLI reference: `migrate status`](https://www.prisma.io/docs/orm/reference/prisma-cli-reference#migrate-status) | [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md) | Exit-code semantics used as the deploy-time drift guard appended after `migrate deploy`. |
| [Prisma — Fixing failed migrations with `migrate resolve`](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing#fixing-failed-migrations-with-migrate-resolve) | [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md) | The recovery path for a failed migration (forward-only model) cited under Consequences. |
| [Google Cloud — Create and execute Cloud Run jobs](https://cloud.google.com/run/docs/create-jobs) | [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md) | The job resource and `gcloud run jobs execute --wait` semantics the pipeline relies on. |
| [Google Cloud — Connect from Cloud Run to Cloud SQL using private IP](https://cloud.google.com/sql/docs/postgres/connect-run#private-ip) | [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md) | The in-VPC connectivity model that lets the job reach the private-IP-only database. |
| [Google Cloud — Configure Serverless VPC Access](https://cloud.google.com/vpc/docs/configure-serverless-vpc-access) | [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md) | The connector that routes the job to the database's private IP. |
| [Google Cloud — Configure private IP for Cloud SQL](https://cloud.google.com/sql/docs/postgres/configure-private-ip) | [ADR-027](adr/ADR-027-deploy-pipeline-migrations.md) | Why a GitHub-hosted runner cannot reach the instance directly — the constraint driving the decision. |
| [Google Cloud — Artifact Registry: push and pull images](https://cloud.google.com/artifact-registry/docs/docker/pushing-and-pulling) | [ADR-029](adr/ADR-029-per-env-artifact-registry-push.md) | Authenticating to and pushing images to a Docker repository; the direct per-registry push ADR-029 adopts in place of a cross-project registry-to-registry copy. |
| [Google Cloud — Artifact Registry access control with IAM](https://cloud.google.com/artifact-registry/docs/access-control) | [ADR-029](adr/ADR-029-per-env-artifact-registry-push.md) | Defines `roles/artifactregistry.reader`/`writer`; the basis for asserting the prod SA needs only *write* on the prod AR and no longer *read* on the staging AR (least privilege). |
| [Docker — `docker buildx imagetools create`](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/) | [ADR-029](adr/ADR-029-per-env-artifact-registry-push.md) | The registry-to-registry copy command ADR-029 replaces; its source-manifest read is what required the cross-project reader grant. |
| [Docker — GitHub Actions cache backend (`type=gha`)](https://docs.docker.com/build/cache/backends/gha/) | [ADR-029](adr/ADR-029-per-env-artifact-registry-push.md) | The GHA cache backend (`cache-from`/`cache-to mode=max`) that lets the staging build's exported cache make the subsequent prod-AR push a cache-resolve rather than a rebuild. |

---

## Testing and CI

| Source | Cited In | Relevance |
|---|---|---|
| [Martin Fowler — The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) | [ADR-013](adr/ADR-013-testing-strategy.md) | The authoritative modern treatment of the test pyramid: what belongs at each layer and why lower layers should dominate by count; the unit/integration/e2e split and keeping business-logic assertions at the lowest viable layer come from here. |
| [Martin Fowler — Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html) | [ADR-013](adr/ADR-013-testing-strategy.md) | Distinguishes the test-double types and explains why classical (state-based) testing with real or in-memory collaborators is preferred over mockist testing for repository adapters; the "no mocks for adapter tests" decision maps to the classical school described here. |
| [Martin Fowler — TestPyramid](https://martinfowler.com/bliki/TestPyramid.html) | [ADR-013](adr/ADR-013-testing-strategy.md) | The original bliki entry coining the pyramid shape and naming the "ice-cream cone" anti-pattern that results from inverting it with too many E2E tests. |
| [Testcontainers for Node.js](https://node.testcontainers.org/) | [ADR-013](adr/ADR-013-testing-strategy.md) | The library used to spin up ephemeral Postgres instances for repository adapter integration tests; each run gets a clean container with no shared state between runs. |
| [Jest](https://jestjs.io/) | [ADR-013](adr/ADR-013-testing-strategy.md) | The test runner used across all workspaces; chosen for first-class TypeScript support, snapshot testing, and compatibility with the Turborepo `test` pipeline task. |
| [Playwright](https://playwright.dev/) | [ADR-013](adr/ADR-013-testing-strategy.md) | The E2E test framework used in `apps/web/e2e/`; chosen over Cypress for multi-browser support, network interception, and stronger headless reliability in containerised CI. |
| [Clerk Backend API — Sign-in Tokens](https://clerk.com/docs/reference/backend-api/tag/Sign-in-Tokens) | [ADR-023](adr/ADR-023-staging-integration-test-design.md) | Official documentation for `createSignInToken`; describes the ticket strategy and the `strategy: 'ticket'` parameter used to bypass all auth factors including MFA. |
| [Clerk Testing — `@clerk/testing` Playwright overview](https://clerk.com/docs/testing/playwright/overview) | [ADR-023](adr/ADR-023-staging-integration-test-design.md) | Official guide for Playwright integration: `clerkSetup()`, `setupClerkTestingToken()`, and the recommended `storageState` pattern for session reuse. |
| [Playwright — Storage State (reuse signed-in state)](https://playwright.dev/docs/auth#reuse-signed-in-state) | [ADR-023](adr/ADR-023-staging-integration-test-design.md) | Canonical pattern for sharing auth state across tests; the global setup / `use.storageState` pairing implements this directly. |
| [GitHub — Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | [ADR-030](adr/ADR-030-github-merge-queue-adoption.md) | States plainly that merge queue requires organization ownership (any visibility), not just public visibility — the eligibility gate this repo currently fails (see #729). Also documents the required `merge_group` workflow trigger and the Build Concurrency / Merge limits settings. |
| [GitHub Actions — Events that trigger workflows § `merge_group`](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#merge_group) | [ADR-030](adr/ADR-030-github-merge-queue-adoption.md) | The `checks_requested` activity type and `GITHUB_SHA`/`GITHUB_REF` semantics for merge-queue runs. |
| [dorny/paths-filter — README](https://github.com/dorny/paths-filter#readme) | [ADR-030](adr/ADR-030-github-merge-queue-adoption.md) | Confirms `merge_group` needs a real checkout + explicit `base` input, unlike the API-based `pull_request` diff. |
| [GitHub REST API — Commit statuses](https://docs.github.com/en/rest/commits/statuses) | [ADR-031](adr/ADR-031-mandatory-review-gate.md) | The API Review Gate reports through; needs only `statuses: write` regardless of triggering event. |
| [GitHub REST API — Checks](https://docs.github.com/en/rest/checks) | [ADR-031](adr/ADR-031-mandatory-review-gate.md) | The alternative to the Commit Status API considered and not used, for reliability reasons across `issue_comment`-triggered runs. |
| [GitHub Docs — About status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repository-settings/about-status-checks) | [ADR-031](adr/ADR-031-mandatory-review-gate.md) | Confirms required-check matching is by context/check name, independent of which API reported it. |
| [GitHub Actions — Events that trigger workflows § `issue_comment`](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#issue_comment) | [ADR-031](adr/ADR-031-mandatory-review-gate.md) | Confirms PR comments (where the `/review` marker is posted) fire `issue_comment`, not `pull_request`. |

---

## Case Studies

Empirical evidence from practitioners. Full case studies are in [`docs/case-studies.md`](case-studies.md).

| Source | Cited In | Relevance |
|---|---|---|
| [Trilon.io Blog](https://trilon.io/blog) | [ADR-011](adr/ADR-011-api-server-nestjs-and-express.md) | Posts from NestJS core contributors on module design, DI patterns, circular dependency resolution, and production deployment; primary source for NestJS startup overhead characterisation. |
| [Next.js 15 Upgrade Guide](https://nextjs.org/docs/app/building-your-application/upgrading/version-15) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | Documents the reversal of the default `fetch` caching behaviour between Next.js 14 and 15; the primary production pain point identified in the App Router case study. |
| [Vercel Engineering Blog](https://vercel.com/blog/engineering) | [ADR-007](adr/ADR-007-nextjs-app-router-web-frontend.md) | Posts by the Next.js team on App Router adoption patterns and production operational experience. |
| [Introducing GKE Autopilot (GA announcement, February 2021)](https://cloud.google.com/blog/products/containers-kubernetes/introducing-gke-autopilot) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Google's GA announcement documenting the Autopilot design rationale; supplements the overview docs with the motivation for the fully-managed node model. |
| [Cloud Run — Concurrency](https://cloud.google.com/run/docs/about-concurrency) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Covers the concurrency model, CPU allocation, and minimum instances; directly relevant to cold start mitigation and cost profile. |
| [Cloud Run — Pricing](https://cloud.google.com/run/pricing) | [ADR-009](adr/ADR-009-infrastructure-kubernetes-cloud-run.md) | Authoritative source for the per-request cost model used in the ADR-009 A/B comparison table. |
| [ThoughtWorks Technology Radar — Hexagonal Architecture](https://www.thoughtworks.com/radar/techniques/hexagonal-architecture) | [ADR-002](adr/ADR-002-ports-and-adapters.md) | ThoughtWorks's ongoing assessment of the pattern; documents adapter proliferation and enforcement failure modes at team scale. |
| [Martin Fowler — BoundedContext](https://martinfowler.com/bliki/BoundedContext.html) | [ADR-002](adr/ADR-002-ports-and-adapters.md) | Relevant context on where adapter boundaries should align with domain boundaries. |
| [GitHub — The GitHub GraphQL API (September 2016)](https://github.blog/2016-09-14-the-github-graphql-api/) | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md) | The canonical production example of dual REST + GraphQL transport; documents the overfetching driver, client migration pattern, and permanent-commitment risk. |
| [Shopify Engineering Blog](https://shopify.engineering/) | [ADR-006](adr/ADR-006-rest-and-graphql-dual-transport.md) | Documents Shopify's GraphQL-first API strategy maintained alongside REST; covers N+1 batching and query complexity scoring. |
