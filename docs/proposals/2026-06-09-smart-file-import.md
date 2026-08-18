# Proposal: Smart File Import Wizard

**Status:** `shipped`
**Date:** 2026-06-09
**Issue:** [#477](https://github.com/merickvaughn/lifting-logbook/issues/477)

> **Phase 1 (MVP) shipped** in [#477](https://github.com/merickvaughn/lifting-logbook/issues/477) — PR [#485](https://github.com/merickvaughn/lifting-logbook/pull/485) (merged `46f9f9c`, 2026-06-09). Open follow-ups: [#483](https://github.com/merickvaughn/lifting-logbook/issues/483) (Phase 2 column-mapper), [#484](https://github.com/merickvaughn/lifting-logbook/issues/484) (Phase 3 split + Undo), [#486](https://github.com/merickvaughn/lifting-logbook/issues/486) (multi-tier strength goals), [#488](https://github.com/merickvaughn/lifting-logbook/issues/488) (commit atomicity / concurrent-import safety), [#489](https://github.com/merickvaughn/lifting-logbook/issues/489) (maintainability consolidation).
>
> **[#884](https://github.com/merickvaughn/lifting-logbook/issues/884) fixed a data-integrity gap** in the `skipDuplicates` idempotency this doc describes (lines below on commit idempotency): the lift-record natural key omitted `date`, so two genuinely different real sets could silently collide and one would be dropped whenever a source dataset legitimately reused a `(cycleNum, workoutNum, lift, setNum)` combination on two different real calendar dates (a cycle-numbering reset, a multi-year gap, historical spreadsheet drift). `date` now joins the natural key everywhere it's used — the JS key function, the `LiftRecord` `@@unique` DB constraint, and the public record `id` — so the database can store both. This does not change the *intended* idempotency behavior described below (a true re-import of identical data, including its date, is still recognized as a duplicate and skipped).

---

## Problem

The Consistent Intermediate Lifter migrating off a brittle Google Sheets / Apps Script setup has not one CSV but four distinct exports — lift history, training maxes, strength goals, and a program spec — and switching tools cannot erase that history. Today's importer ([#225](https://github.com/merickvaughn/lifting-logbook/issues/225), shipped in PR #236) only handles **lift records**, requires the user to already know which file they're holding, lives on a single program page, commits directly, and offers no preview. The persona wants to drop *any* of their files in and have the app "intelligently figure out how to import" it — with a chance to review and fix before anything is written. The current flow forces them to be the classifier, the mapper, and the validator, which is exactly the friction that keeps history trapped in the spreadsheet.

## Proposed Solution

A multi-step import **wizard** that accepts any CSV, auto-detects its type, maps columns, lets the user review and repair rows, previews the before→after effect, and commits — covering all four data types the app stores. The standalone design prototype committed at [`docs/proposals/assets/2026-06-09-smart-file-import.prototype.html`](assets/2026-06-09-smart-file-import.prototype.html) is the **design of record** for the seven steps (Source → Analyzing → Classify → Map columns → Review → Preview → Done).

This extends, rather than discards, the existing single-purpose importer. We reuse the parsing, normalization, and write primitives already in the codebase and add the new "intelligence" layer (classifier + fuzzy mapper) and a preview-then-commit API around them.

**Reused as-is:**
- Parsers in `packages/core/src/utils/parser/`: `parseLiftRecords`, `parseTrainingMaxes`, `parseLiftingProgramSpec`, and the shared `parseCsvText` text util.
- Domain models `TrainingMax`, `LiftingProgramSpec`, `StrengthGoalEntry`.
- Repo writes `appendLiftRecords` (Prisma `createMany` with `skipDuplicates`), `saveTrainingMaxes` (upsert), `upsertGoal` (upsert).
- Lift-name normalization via `DEFAULT_SLOT_MAP` in `packages/core/src/catalog/slotMaps.ts`.
- The validator pattern established by `validateLiftImport` in `packages/core/src/utils/import/`.
- The existing endpoint `POST /programs/:program/lift-records/import` (`apps/api/src/programs/lift-records.controller.ts`) as the reference for caps (5 MB / `MAX_IMPORT_ROWS=5000`) and chunked duplicate detection (`findExistingRecords`, 500/query), plus `@fastify/multipart` already configured in `apps/api/src/main.ts`.
- The existing web upload component `apps/web/app/(authed)/cycle/[cycleNum]/program/LiftRecordsImportForm.tsx` as the file-input reference.

**New backend work (in `packages/core` unless noted):**
- `parseStrengthGoals` — the `Strength_Goals` CSV uses a **transposed / pivoted** layout, so no parser exists yet; this must be built alongside the three existing parsers.
- A **signal-based format classifier** that scores a parsed table → `{ type, confidence, reasons[], alternatives[] }`. It must use weighted signals (column-shape, value patterns, lift-catalog hit rate), **not** exact-header matching, so it tolerates Strong-app exports, hand-typed sheets, and RPT variants. `alternatives[]` carries each rejected destination's own confidence and a "close call" flag.
- A **fuzzy column-mapper** that maps arbitrary headers → canonical fields with a per-column match-confidence and transformation notes (split `"A x B"` into reps, normalize lift names via `DEFAULT_SLOT_MAP`, flag weekday strings that can't resolve to a date), reusing the catalog map.
- **Per-kind validators + preview/diff builders** that produce `{ creates, updates, skips }` counts plus before→after deltas, and the **row-level destination split** (e.g. a "1RM Test" lift row routing to Training Maxes instead of Lift History).
- A **write method on `ILiftingProgramSpecRepository`**, which is currently read-only.
- A **unified preview→commit API**: recommended `POST /programs/:program/import` with `mode=preview|commit`. The server **re-parses on commit and never trusts the client payload**; commit is idempotent via `skipDuplicates` / upsert and respects the existing size/row caps.

**Frontend:**
- A multi-step wizard under `apps/web/app/(authed)/import/` implementing the prototype's seven steps. All `fetch()` calls must follow [`docs/standards/fetch-cache-semantics.md`](../standards/fetch-cache-semantics.md) (explicit `{ cache: 'no-store' }` for these mutation/preview reads).

## Resolved Design Decisions

These were open questions settled during proposal review:

1. **Auto-accept threshold is configurable per data type.** Each of the four types carries its own high/medium/low confidence thresholds rather than one global value — a lift-records file and a transposed strength-goals file have very different signal strengths, so a single cutoff would be wrong for at least one.
2. **Undo (Phase 3) uses a pre-image snapshot + restore, not delete-only.** Lift records are append-only, so undoing them is "delete the rows this batch inserted." But training maxes, strength goals, and program spec commit via **upsert**, where a delete-only undo would wrongly erase a pre-existing value the import merely overwrote (e.g. importing a Squat TM `250 → 260`, then undoing, must restore `250` — not delete the Squat TM entirely). The import-batch record therefore snapshots each touched key's prior value (or "absent"); undo restores the prior value for updated rows and deletes newly-created rows. **Guard:** if a row's current value no longer matches what the import wrote (the user edited it after importing), undo skips that row and flags it rather than clobbering the later edit.
3. **Low-confidence classification lets the user pick or skip.** When no destination clears its auto-accept threshold (or there is no clear winner), the wizard does not guess: it surfaces the ranked candidates and lets the user **manually choose a destination and continue**, or **skip the file**. It never silently routes a low-confidence file.

## Acceptance Criteria

### Phase 1 (MVP)

- [ ] `parseStrengthGoals` parses the transposed `Strength_Goals` CSV into `StrengthGoalEntry[]`, with core unit tests covering the pivoted layout, missing values, and lbs/kg unit awareness.
- [ ] A file-level classifier in `packages/core` returns `{ type, confidence, reasons[], alternatives[] }` for a parsed table, routing to one of Lift History, Training Maxes, Strength Goals, or Programs using weighted signals (not exact-header matching).
- [ ] Classifier confidence is bucketed (high ≥ 0.9 / medium ≥ 0.7 / low) against **per-type** thresholds with an auto-accept threshold; results expose human-readable `reasons[]` and `alternatives[]` (each with its own confidence % and `closeCall` flag).
- [ ] When classification is low-confidence / has no clear winner, the Classify step lets the user manually pick a destination and continue, or skip the file — it never auto-routes.
- [ ] A write method is added to `ILiftingProgramSpecRepository` and its implementation; existing read callers are unaffected.
- [ ] Per-kind validators and preview/diff builders produce `{ creates, updates, skips }` counts and before→after deltas (TM before→after, goal current→target gap + deadline) for all four types.
- [ ] `POST /programs/:program/import` supports `mode=preview` (returns classification + per-kind preview, writes nothing) and `mode=commit` (re-parses the uploaded file server-side, never trusting the client preview payload).
- [ ] Commit is idempotent: re-running the same file produces zero net new rows via `skipDuplicates` (lift records) / upsert (TM, goals, program spec); the 5 MB / `MAX_IMPORT_ROWS=5000` caps and chunked duplicate detection are enforced.
- [ ] The wizard under `apps/web/app/(authed)/import/` implements Source → Analyzing → Classify → (basic) Review → Preview → Done, behind a single unified upload entry point (not a per-page importer).
- [ ] Classify step renders detected type, confidence bucket, destination, "Why this classification" reasons, and "Other possibilities considered" alternatives, per the prototype.
- [ ] **Tests:** core unit tests for the classifier and all four parsers/validators; API E2E (in-memory) for `mode=preview` and `mode=commit` for each of the four types; a Playwright path covering Source → Classify → Preview → Done for at least one type. New endpoint + new frontend feature both carry coverage per the repo's blocking rule.

### Phase 2

> May split into a follow-up issue.

- [ ] A Map-columns step maps each source column to a canonical field with a per-column match-confidence %.
- [ ] Required fields are starred and gate progression until mapped; override dropdowns let the user re-map any column.
- [ ] Transformation notes are surfaced per column (split `"A x B"` into reps, lift-name normalization, unresolvable-weekday flags).
- [ ] **Tests:** core unit tests for the fuzzy column-mapper (arbitrary headers → canonical fields, confidence scoring, transformation notes); Playwright coverage of the override-and-continue path.

### Phase 3

> May split into a follow-up issue.

- [ ] Per-row destination disambiguation: a single row (e.g. a "1RM Test") can be routed to Training Maxes instead of Lift History, and the Preview step shows split-destination cards (N → Lift History AND M → Training Maxes).
- [ ] The lift-records Review step provides filter chips (all / incomplete / ambiguous), shift-range multi-select, a bulk-edit bar (set date/lift/weight/reps, exclude), and inline fixers with lift-catalog autocomplete for missing required fields.
- [ ] Training-maxes / strength-goals Review supports inline fix of missing values and exclude/include with live delta recompute.
- [ ] An import-batch record is persisted on commit with a pre-image snapshot per touched key; "Undo this import" restores prior values for updated rows and deletes newly-created rows, skipping and flagging any row edited since import.
- [ ] **Tests:** core unit tests for the row-level split logic and undo pre-image restore (including the post-import-edit guard); API E2E for split-destination commit and for undo reversing only the target batch; Playwright coverage of bulk-edit and undo.

## Out of Scope

- Export (the reverse direction — generating CSVs from the app).
- Mobile client upload UI (`apps/mobile`).
- Importing the user's own actual CSVs into their account — that is a post-feature action the user takes, not part of building the feature.
- Real-time collaborative editing of an in-progress import.
- Bulk Undo across multiple past imports — Phase 3 Undo covers only the just-completed import.

## Open Questions

- **Which program does an auto-detected import target, and where is that chosen?** Every write path is program-scoped (the proposed `POST /programs/:program/import`, matching #225), but the prototype's Source step shows no program selector and the app supports multiple programs per user. Options: (a) launch the wizard from within a program context so `:program` is implicit; (b) add an explicit program-picker step; or (c) let the classifier's destination drive it (a program-spec file *creates* a program; the other three target the active one). To settle at the start of Phase 1, since it shapes the API surface and the Source-step UX.

## References

- [`docs/proposals/assets/2026-06-09-smart-file-import.prototype.html`](assets/2026-06-09-smart-file-import.prototype.html) — the committed design prototype; design of record for the seven wizard steps and all UI affordances referenced above.
- [`docs/proposals/2026-05-11-historical-lift-data-backfill.md`](2026-05-11-historical-lift-data-backfill.md) — the prior lift-records-only importer this proposal supersedes and generalizes to all four data types.
- [Prisma Client `createMany` reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany) — documents the `skipDuplicates` option that makes lift-record commit idempotent.
- [RFC 7578 — Returning Values from Forms: multipart/form-data](https://www.rfc-editor.org/rfc/rfc7578) — the multipart upload format the `@fastify/multipart` file-upload endpoint accepts.
