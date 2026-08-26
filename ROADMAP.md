# Lifting Logbook — Roadmap

Lifting Logbook is a personal strength training tracker replacing a Google Apps Script /
Google Sheets implementation with a cloud-native web and mobile product. See [`docs/PRD.md`](docs/PRD.md)
for the full product definition.

**This is a human-curated editorial view.** It does not auto-sync from GitHub. New features
are proposed via `/propose`, which creates the proposal doc, the GitHub issue, and the entry
below. Status is updated manually as work progresses.

---

## v0.1 — Foundation `[Shipped]`

Monorepo scaffolding, port interfaces, shared types, and CI/CD. The goal is a working
skeleton where every app and package is wired together and the core hexagonal architecture
is codified.

### Shipped

| Work stream | Description | Issues |
|---|---|---|
| App scaffolding | Scaffold `apps/web` (Next.js App Router) and `apps/mobile` (Expo) | [#9](https://github.com/merickvaughn/lifting-logbook/issues/9), [#10](https://github.com/merickvaughn/lifting-logbook/issues/10) |
| Port interfaces | Define `IAuthProvider`, data repository ports, and `IRepositoryFactory` | [#11](https://github.com/merickvaughn/lifting-logbook/issues/11), [#12](https://github.com/merickvaughn/lifting-logbook/issues/12), [#13](https://github.com/merickvaughn/lifting-logbook/issues/13) |
| Shared types | Domain types and API contract types in `packages/types` | [#14](https://github.com/merickvaughn/lifting-logbook/issues/14), [#15](https://github.com/merickvaughn/lifting-logbook/issues/15) |
| CI/CD foundation | Lint and test on PR; Docker build and push on merge to main | [#16](https://github.com/merickvaughn/lifting-logbook/issues/16), [#17](https://github.com/merickvaughn/lifting-logbook/issues/17) |
| Process infrastructure | ROADMAP and `docs/proposals/` convention | [#58](https://github.com/merickvaughn/lifting-logbook/issues/58) |
| Developer onboarding guide | `docs/onboarding.md` — clone → first PR walkthrough; sequences existing docs and ADRs without duplicating them | [#200](https://github.com/merickvaughn/lifting-logbook/issues/200) |

### Proposals

| Proposal | Description | Issue | Status |
|---|---|---|---|
| [Developer Onboarding Guide](docs/proposals/2026-05-08-onboarding-guide.md) | Single `docs/onboarding.md` walking new engineers from clone to first PR; sequences existing docs and ADRs | [#200](https://github.com/merickvaughn/lifting-logbook/issues/200) | shipped |

---

## v0.2 — Core API `[Shipped]`

A working REST + GraphQL API backed by real adapters. Core module quality gates enforced.
Architecture decisions for data access and security documented.

### Active Work

| Work stream | Description | Issues |
|---|---|---|
| *(all shipped)* | | |

### Shipped

| Work stream | Description | Issues |
|---|---|---|
| Architecture documentation | ADR-014 credential encryption; cache invalidation strategy; Express legacy archival policy | [#38](https://github.com/merickvaughn/lifting-logbook/issues/38), [#39](https://github.com/merickvaughn/lifting-logbook/issues/39), [#42](https://github.com/merickvaughn/lifting-logbook/issues/42) |
| Core module cleanup | Enable strict TypeScript; remove GAS Logger dependency | [#51](https://github.com/merickvaughn/lifting-logbook/issues/51), [#52](https://github.com/merickvaughn/lifting-logbook/issues/52) |
| ADR-015 | GraphQL DataLoader design: scope, batching, and request isolation | [#40](https://github.com/merickvaughn/lifting-logbook/issues/40) |
| ADR-016 | Cycle planning agent: LLM integration, tool schema, and adapter boundary | [#55](https://github.com/merickvaughn/lifting-logbook/issues/55) |

### Proposals

| Proposal | Description | Issue | Status |
|---|---|---|---|
| [Lift Library and Exercise Tagging](docs/proposals/2026-04-13-lift-library-exercise-tagging.md) | First-class `Lift` domain type with compound/accessory classification, movement tags, and configurable program exercise slots | [#64](https://github.com/merickvaughn/lifting-logbook/issues/64) | shipped |
| [Grafana Cloud Observability Stack](docs/proposals/2026-05-08-grafana-cloud-observability-stack.md) | OpenTelemetry tracing, metrics, and logs in `apps/api` and `apps/web` exporting to Grafana Cloud, with RED-style alerts | [#199](https://github.com/merickvaughn/lifting-logbook/issues/199) | shipped |

---

## v0.3 — Client Applications `[Shipped]`

Web and mobile clients functional end-to-end. Key user-facing features implemented.

### Active Work

| Work stream | Description | Issues |
|---|---|---|
| *(all shipped)* | | |

### Shipped

| Work stream | Description | Issues |
|---|---|---|
| Bodyweight exercise tracking | Domain/core layer: `BodyWeightEntry` type, `isBodyweightComponent` flag, catalog metadata, `calculateAddedWeight` utility | [#29](https://github.com/merickvaughn/lifting-logbook/issues/29) |
| Mobile dependency wiring | `@logbook/types` already declared in `apps/mobile/package.json`; hoisted by npm workspaces — no code change needed | [#50](https://github.com/merickvaughn/lifting-logbook/issues/50) |
| Cycle Dashboard Screen | `/cycle` and `/cycle/:cycleNum` — week grid, planned weights, completion status; `tsc-alias` fix for Turbopack | [#104](https://github.com/merickvaughn/lifting-logbook/issues/104) |
| Configurable week grouping | Remove `WeekNumber = 1\|2\|3\|4` type constraint and `MAX_WORKOUT_NUM = 8` API limit; source week from program spec | [#116](https://github.com/merickvaughn/lifting-logbook/issues/116) |
| Strength goal tracking | `StrengthGoal` domain types and `evaluateStrengthTier` utility; system-default Kilgore/Rippetoe standards for Big 4 + chin-up | [#111](https://github.com/merickvaughn/lifting-logbook/issues/111) |
| Training Max Management Screen | PATCH endpoint + `/settings/training-maxes` UI; inline editable 1RMs with validation, Server Action for save, Settings nav link | [#108](https://github.com/merickvaughn/lifting-logbook/issues/108) |
| Initial Training Max Discovery | `WeekType` (`training`/`test`/`deload`), `estimateTrainingMax` (Brzycki), test/deload branches in `generateLiftPlan` and `updateMaxes`, `currentWeekType` in API response | [#129](https://github.com/merickvaughn/lifting-logbook/issues/129) |
| Workout Logging Screen | Per-exercise logging with warm-ups, bodyweight gate, and whole-workout overview toggle; `POST /lift-records`, `PATCH /lift-records/:id`, `GET/POST /body-weight/latest` | [#133](https://github.com/merickvaughn/lifting-logbook/issues/133) |
| Cycle planning — implementation | LLM-powered training cycle recommendations with swappable providers, using design from ADR-016 | [#54](https://github.com/merickvaughn/lifting-logbook/issues/54) |
| A/B comparison documentation | Exit criteria and CI event taxonomy enforcement for Express/NestJS comparison | [#41](https://github.com/merickvaughn/lifting-logbook/issues/41) |
| Per-user repository factory | `IRepositoryFactory` port with `forUser(AuthUser)`, `InMemoryRepositoryFactory` (per-user isolated bundles), `SystemDbRepositoryFactory` (adapter-type dispatch + single-flight cache); all 8 controllers threaded through factory; auth guard isolation E2E test | [#144](https://github.com/merickvaughn/lifting-logbook/issues/144) |
| Workout detail and rescheduling | Per-workout detail screen (date, week, status, planned lifts with set counts, lift history drilldown); per-workout date override with `PATCH .../reschedule` endpoint; cycle dashboard cards now link to detail | [#177](https://github.com/merickvaughn/lifting-logbook/issues/177) |
| Training max history | `training_max_history` table, GET/PATCH endpoints with date and PR filters, MaxHistory component on settings page, ADR-017 documented | [#174](https://github.com/merickvaughn/lifting-logbook/issues/174) |
| Strength goal CRUD | `strength_goal` DB model, CRUD endpoints, `/settings/strength-goals` page with progress bars and quick-access dashboard button | [#175](https://github.com/merickvaughn/lifting-logbook/issues/175) |
| Cycle Program and Plan views | Four quick-access buttons on cycle dashboard; `/cycle/:cycleNum/program` and `/cycle/:cycleNum/plan` pages for program spec and 6-phase plan overview | [#176](https://github.com/merickvaughn/lifting-logbook/issues/176) |
| Manage lifts | Per-workout add/remove/replace overrides stored in `workout_lift_override` table; `GET /workouts/:workoutNum` returns planned lifts for upcoming workouts; manage-lifts and lift-picker web pages | [#178](https://github.com/merickvaughn/lifting-logbook/issues/178) |
| Lift metadata | Per-user, per-lift metadata: muscle groups (`string[]`), substitutions (`string[]`), foundational flag (`boolean`); `GET /lifts/:lift/metadata` + `PATCH /lifts/:lift/metadata`; `LiftEditor` component + edit page + Edit link in manage-lifts | [#179](https://github.com/merickvaughn/lifting-logbook/issues/179) |
| Onboarding program catalog | Full 13-program catalog with `Purpose`/`Goal` union types, experience + goal filters, "View Full Catalog" cross-tier sub-view, rich detail view (purpose tags, Core Lifts, duration/frequency grid, sample schedule), server-side availability guard, `useTransition` + Server Action wiring → `/cycle/1` | [#180](https://github.com/merickvaughn/lifting-logbook/issues/180) |
| Integration tests | Cross-cutting e2e scenarios for strength goals, training max history, rescheduling, manage lifts, and lift metadata; `?isPR=true` filter coverage in DB suite; in-memory adapter wiring audit | [#181](https://github.com/merickvaughn/lifting-logbook/issues/181) |
| Workout Scheduling Override | User-defined fixed or rotating A/B schedule; auto-distributes cycle workout dates; skip/unskip UI with optional reason; schedule-mode confirmation prompt on program switch; Playwright E2E coverage | [#269](https://github.com/merickvaughn/lifting-logbook/issues/269) |
| Program-First Onboarding | Reorder wizard to Method → Program → Lifts → Confirm; seed lifts panel from `PRESET_BASE_SPECS` on program selection; `STEP` constants; `applyFilters` `useCallback`; 3 new navigation tests | [#599](https://github.com/merickvaughn/lifting-logbook/issues/599), [#602](https://github.com/merickvaughn/lifting-logbook/issues/602) |
| Smart Import Phases 2–3 | Phase 2: fuzzy column mapper and MAP_COLUMNS step (PR [#613](https://github.com/merickvaughn/lifting-logbook/pull/613)); Phase 3: interactive REVIEW table with per-row exclusion and lift-override autocomplete, `import_batch` pre-image + undo endpoint, `applyColumnOverrides`, `parseLiftRecordNaturalKey`/`parseProgramSpecNaturalKey` in core (PR [#617](https://github.com/merickvaughn/lifting-logbook/pull/617)) | [#615](https://github.com/merickvaughn/lifting-logbook/issues/615), [#483](https://github.com/merickvaughn/lifting-logbook/issues/483), [#484](https://github.com/merickvaughn/lifting-logbook/issues/484) |

### Proposals

| Proposal | Description | Issue | Status |
|---|---|---|---|
| [Workout Logging Screen](docs/proposals/2026-04-29-workout-logging-screen.md) | Per-exercise logging with warm-ups, bodyweight gate, and whole-workout overview toggle | [#106](https://github.com/merickvaughn/lifting-logbook/issues/106) | shipped |
| [Training Max Management Screen](docs/proposals/2026-04-29-training-max-management.md) | View and edit per-lift 1RMs at `/settings/training-maxes`; drives all working set calculations | [#108](https://github.com/merickvaughn/lifting-logbook/issues/108) | shipped |
| [Strength Goal Tracking](docs/proposals/2026-04-29-strength-goal-tracking.md) | Per-lift, per-tier strength standards (intermediate/advanced/elite) with target and observed dates | [#111](https://github.com/merickvaughn/lifting-logbook/issues/111) | shipped |
| [Initial Training Max Discovery](docs/proposals/2026-04-30-initial-training-max-discovery.md) | Estimation utility (Brzycki) and test-week cycle phase for users with no existing training maxes | [#129](https://github.com/merickvaughn/lifting-logbook/issues/129) | shipped |
| [On-Call Readiness](docs/proposals/2026-05-08-on-call-readiness.md) | Runbooks, SLOs, incident response guide, and severity/escalation framework; sequences after #199 | [#201](https://github.com/merickvaughn/lifting-logbook/issues/201) | shipped |
| [Historical Lift Data Backfill](docs/proposals/2026-05-11-historical-lift-data-backfill.md) | CSV upload endpoint and web UI to ingest historical `LiftRecord` rows with all-or-nothing validation | [#225](https://github.com/merickvaughn/lifting-logbook/issues/225) | declined |
| [Workout Scheduling Override](docs/proposals/2026-05-17-workout-scheduling-override.md) | User-defined preferred workout days (fixed or rotating A/B) + per-program `workoutsPerWeek` override with automatic cycle date distribution | [#267](https://github.com/merickvaughn/lifting-logbook/issues/267) | shipped |
| [Custom User-Created Lifts](docs/proposals/2026-06-03-custom-lifts.md) | Per-user persisted `CustomLift` entity (Prisma model + `ICustomLiftRepository` port + ownership isolation); `resolveLift` prefers custom over catalog; `GET/POST/PATCH/DELETE /lifts/custom`. Foundational for #426 and #427 | [#425](https://github.com/merickvaughn/lifting-logbook/issues/425) | shipped |
| [Onboarding — Any-Lift Max Estimation](docs/proposals/2026-06-03-onboarding-any-lift-max-estimation.md) | Dynamic add/remove lift list in onboarding for any catalog or custom lift; persists confirmed maxes (closes the discard gap in `createFirstCycle`) | [#426](https://github.com/merickvaughn/lifting-logbook/issues/426) | shipped |
| [Lift Movement Profiles](docs/proposals/2026-06-03-lift-movement-profiles.md) | Combined `MovementProfile` (patterns + joint actions + complexity) on `Lift`; preconfigured for the 23 catalog entries, editable for custom lifts | [#427](https://github.com/merickvaughn/lifting-logbook/issues/427) | shipped |
| [Smart File Import Wizard](docs/proposals/2026-06-09-smart-file-import.md) | Auto-detects a CSV's type (lift records, training maxes, program spec, strength goals), maps columns with confidence, reviews/fixes rows, previews before→after, then commits; generalizes #225 to all four data types. All three phases shipped: Phase 1 (MVP) in [#477](https://github.com/merickvaughn/lifting-logbook/issues/477) (PR [#485](https://github.com/merickvaughn/lifting-logbook/pull/485)); Phase 2 (fuzzy column mapper) in PR [#613](https://github.com/merickvaughn/lifting-logbook/pull/613); Phase 3 (REVIEW step, undo, column overrides) in [#615](https://github.com/merickvaughn/lifting-logbook/issues/615) (PR [#617](https://github.com/merickvaughn/lifting-logbook/pull/617)). Hardening tracked by [#486](https://github.com/merickvaughn/lifting-logbook/issues/486)/[#488](https://github.com/merickvaughn/lifting-logbook/issues/488)/[#489](https://github.com/merickvaughn/lifting-logbook/issues/489) | [#477](https://github.com/merickvaughn/lifting-logbook/issues/477) | shipped |
| [Program-First Onboarding with Auto-Seeded Lifts](docs/proposals/2026-06-28-onboarding-program-first-lift-seeding.md) | Reorder wizard to Choose Program before Enter Lifts; seed the lifts panel from `PRESET_BASE_SPECS` when the list is empty; depends on #592 for full RPT coverage | [#599](https://github.com/merickvaughn/lifting-logbook/issues/599) | shipped |
| [On-Demand Release Notes Digest](docs/proposals/2026-07-05-release-notes-digest.md) | Generator turns squash-merge history into a Keep a Changelog `CHANGELOG.md` + matching GitHub Release, plus a `/whats-new` page and a non-blocking staleness nag; manual/on-demand trigger, milestone-based versioning | [#723](https://github.com/merickvaughn/lifting-logbook/issues/723) | draft |

---

## v0.4 — Alpha Release `[Current]`

First deployable version. Styled web app running against a real database, deployed and accessible to known users. Mobile deferred to v1.0.

### Active Work

| Work stream | Description | Issues |
|---|---|---|
| *(all shipped)* | | |

### Shipped

| Work stream | Description | Issues |
|---|---|---|
| Design system and styling | Global CSS reset, design tokens, and styled screens informed by Claude Design mockups | [#148](https://github.com/merickvaughn/lifting-logbook/issues/148) |
| Deployment infrastructure | Cloud Run or GKE manifests, Terraform shared infra, CI/CD deploy on merge | [#149](https://github.com/merickvaughn/lifting-logbook/issues/149) |
| Real database adapter | Prisma schema, `SystemDbRepositoryFactory` implementations, migration runner | [#150](https://github.com/merickvaughn/lifting-logbook/issues/150) |
| Database integration tests | E2e suite against real Postgres; covers PATCH endpoint gap and row-level isolation | [#151](https://github.com/merickvaughn/lifting-logbook/issues/151) |

### Proposals

| Proposal | Description | Issue | Status |
|---|---|---|---|
| [Download My Data — Full Logbook Export](docs/proposals/2026-08-26-download-my-data-export.md) | One-click `Settings → Data` export: a timestamped `.zip` holding four re-importable CSVs (one per `ImportKind`, so a backup restores through the existing `/import` wizard) plus a complete `logbook.json` bundle covering every user-scoped table | [#947](https://github.com/merickvaughn/lifting-logbook/issues/947) | draft |

---

## Maintenance

- **Adding an item:** run `/propose <idea>` — it creates the proposal doc, the GitHub issue,
  and the entry in the appropriate milestone section above.
- **Updating status:** edit this file directly when work starts, completes, or is deferred.
  No special workflow required for status changes.
- **Milestone scope changes:** material changes (moving items between milestones, dropping
  items) follow the same PR process as `docs/PRD.md` material changes — explicit statement
  of what changed and why.
