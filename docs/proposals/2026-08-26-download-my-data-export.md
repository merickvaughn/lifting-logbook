# Proposal: Download My Data — Full Logbook Export

**Status:** `draft`
**Date:** 2026-08-26
**Issue:** [#947](https://github.com/merickvaughn/lifting-logbook/issues/947)

---

## Problem

Import is a first-class capability; export does not exist. The Smart Import wizard
([#477](https://github.com/merickvaughn/lifting-logbook/issues/477)) classifies a CSV, fuzzy-maps
its columns, validates it row by row, previews the before/after, commits it, and can undo the
batch — across all four `ImportKind` destinations. A repo-wide scan for `text/csv`,
`Content-Disposition`, or an `/export` route in `apps/` and `packages/` returns only import-side
files. Data goes in; nothing comes out.

The consequence is that a lifter's entire training history exists solely inside the app's
Postgres, with no copy they control. That is a regression against the Google Sheets logbook this
product replaces (`ROADMAP.md:3`), where the lifter owned the file outright and could copy it
anywhere. It also rests the PRD's "0 data-loss incidents in any 30-day period" success metric
entirely on infrastructure the user cannot see, verify, or fall back on.

## Proposed Solution

A **Settings → Data** screen with one action — **Download my data** — that returns a single
timestamped `.zip` containing the user's complete logbook:

- **Four CSVs**, one per `ImportKind` (`lift-records`, `training-maxes`, `strength-goals`,
  `program-spec`), written in the exact shapes the existing parsers in
  `packages/core/src/utils/parser/` already accept.
- **`logbook.json`**, covering every user-scoped table — including the eleven that no
  `ImportKind` covers: cycle dashboard, training-max history, body weight, the three
  workout-override tables, lift metadata, custom lifts, user settings, scheduled workouts, and
  custom programs.

The round-trip is the whole point. Because the CSVs match what `/import` already ingests, a
downloaded backup is restorable through the existing wizard on day one **for the four covered
destinations** — no new import path to build, and no format invented for this feature.
`packages/types/src/api.ts` already describes the four destinations as mirroring "the four CSV
exports the app stores"; this proposal makes that sentence true of the app itself rather than only
of its predecessor. `logbook.json` carries `schemaVersion` and `exportedAt` so a future restore
path can migrate older bundles.

One gap is worth naming rather than discovering later: the `program-spec` import writes only
`CustomProgramSpec` rows (`apps/api/src/adapters/prisma/hybrid-program-spec.repository.ts`), while
the parent `CustomProgram` row — its `name`, `description`, and `baseTemplate` — is written solely
by the `/custom-programs` CRUD path (`apps/api/src/custom-programs/custom-programs.repository.ts`).
So a CSV-only restore rebuilds a custom program's spec rows but not its identity. That metadata
rides in `logbook.json`, which has no import path today; see Open Questions.

The feature is read-only and additive: no schema change, and rollback is deleting the route.

This does not conflict with **J5** ("session data synced; no manual export required"). J5 governs
cross-device sync. This is durability and portability — the user's own copy, held outside the
system — which is a different job from keeping two devices in agreement.

## Acceptance Criteria

- [ ] A `Settings → Data` page exists, registered through the existing
      `apps/web/app/(authed)/settings/sections.ts` pattern, offering a single "Download my data"
      action
- [ ] The action downloads one `lifting-logbook-export-<YYYY-MM-DD>.zip` containing
      `lift-records.csv`, `training-maxes.csv`, `strength-goals.csv`, `program-spec.csv`, and
      `logbook.json`
- [ ] Each of the four CSVs re-imports through `/import` on a non-empty account with the correct
      destination auto-classified and zero validation errors — **proven by a test, not by
      inspection**
- [ ] An account with no data still produces a valid archive — header-only CSVs and empty
      collections in `logbook.json`, never an error or a zero-byte file (onboarding makes
      empty accounts a routine state, not an edge case)
- [ ] Every user-scoped table in `apps/api/prisma/schema.prisma` is represented in
      `logbook.json` (15 models; `ImportBatch` is excluded as internal undo state, not user
      data), plus `schemaVersion` and `exportedAt`. Nesting a child under its parent counts as
      represented — `CustomProgramSpec` belongs under `CustomProgram` — so the contract is
      coverage, not a flat top-level key count
- [ ] `packages/core` gains a `serializeCsvText` that round-trips against the existing
      `parseCsvText` — `parse(serialize(x))` equals `x` — with unit tests reusing the existing
      parser fixtures
- [ ] The export endpoint is authenticated (never `@Public`), and its E2E test runs under the
      RLS-restricted database role, asserting that a second user's rows never appear in the first
      user's export
- [ ] In-memory E2E covers the endpoint; a Playwright spec covers the page; and
      `npm run test:e2e -w @lifting-logbook/web` passes locally, since new UI strings land
- [ ] Export start and finish are logged with per-table row counts only — never row contents

## Out of Scope

- **Any Google integration.** No OAuth, no Drive or Sheets write. The user saves the `.zip`
  wherever they like, Google Drive included. This was the original framing of the request and is
  deliberately declined: it trades a large integration surface (OAuth consent, token storage and
  refresh, encryption at rest, revocation handling) for convenience the file manager already
  provides.
- **Scheduled or automatic backups.** On-demand download only.
- **Restoring from `logbook.json`.** The four CSVs already restore through `/import`; a JSON
  restore path is a follow-up once the bundle's shape has settled.
- **Infrastructure-side backup.** Cloud SQL logical exports to GCS, retention tiers, and a tested
  restore runbook are tracked separately in
  [#946](https://github.com/merickvaughn/lifting-logbook/issues/946). That issue protects the
  operator; this one protects the user.
- **Account deletion / GDPR erasure.** Portability only; deletion is a separate concern.

## Open Questions

- **One PR or two?** The four CSVs (with the core serializer) and the JSON bundle are separable.
  Recommend shipping the CSVs first — they carry the restore story for the four covered
  destinations — then the bundle.
- **Should custom-program metadata get an import path?** Per the gap named in Proposed Solution, a
  CSV-only restore loses a custom program's `name`/`description`/`baseTemplate`. Options: accept it
  for now and document the limitation in the export UI; extend the `program-spec` import to upsert
  the parent row; or fold it into the eventual `logbook.json` restore path. Worth deciding before
  the CSV-first PR merges, since it determines whether "restorable on day one" needs an asterisk.
- **Size ceiling.** No cap is proposed; a multi-year history is still tens of thousands of rows.
  If measurement says otherwise, stream rather than paginate: a silently partial backup is worse
  than a slow one.
- **Zip dependency.** The chosen approach adds one zip library to `apps/web` only, keeping the
  API a pure data boundary that returns CSV text plus JSON. The alternative — five separate
  download links, zero new dependencies — was considered and rejected on UX grounds.

## References

- [ADR-004 — Multi Data Store Adapters](../adr/ADR-004-multi-data-store-adapters.md) — the
  mapper/parser layer this export inverts
- [Smart File Import Wizard](2026-06-09-smart-file-import.md) — defines the four `ImportKind`
  destinations and the CSV shapes this export must match
- [RFC 4180 — Common Format and MIME Type for Comma-Separated Values (CSV) Files](https://www.rfc-editor.org/rfc/rfc4180)
  — quoting and escaping rules the serializer must satisfy
- [Next.js — Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
  — streaming a file response with `Content-Disposition`
