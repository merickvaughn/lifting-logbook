# Proposal: Store Lifts by Stable ID

**Status:** `draft`
**Date:** 2026-11-05
**Issue:** [#1134](https://github.com/merickvaughn/lifting-logbook/issues/1134)

---

## Problem

A lift is a free string in the database, and readers mostly match it by exact string. A lifter who imports history from a spreadsheet can get a wrong planned weight, a re-import that doesn't recognize its own rows, or orphaned history after a rename. The app is deployed to known users in the v0.4 Alpha Release, so fixing this now means migrating real data safely.

### Findings

| # | Finding | Consequence |
|---|---------|-------------|
| 1 | The string can hold a display name (`Front Squat`), a slot name (`Squat`), a catalog ID (`back-squat`) or a custom lift's universally unique identifier (UUID). | One lift can be stored under several strings. |
| 2 | An imported `Bench P.` is stored as `bench-press` and doesn't match a program's `Bench Press`. | Reproduced in [#1118](https://github.com/merickvaughn/lifting-logbook/issues/1118): every planned set computes from a max of 0, the lift detail page shows no max or sets, `GET /workouts/1` lists the lift twice, and `POST /training-maxes/recalculate` returns 500. |
| 3 | Natural keys include the lift string. | A re-import under a different spelling does not recognize its earlier rows. |
| 4 | Renaming a custom lift does not update rows that store the old name. | Its history is orphaned (`docs/domain-model.md` D3). |
| 5 | `OH Press` and `OH Press-HV` both map to `overhead-press`, but have separate maxes (115 and 75) in `packages/core/tests/fixtures/training_maxes.csv` and separate slots in `packages/core/tests/fixtures/rpt_program_spec.csv`. | Through validation and classification today, 75 is written and 115 is skipped, with no errors. This was run directly; the HTTP path was not run. [PR #1129](https://github.com/merickvaughn/lifting-logbook/pull/1129) (open at the time of writing) would keep the newest row instead, treating them as one lift. |
| 6 | The shipped leangains, rpt and 5-3-1 presets have no two slots resolving to one catalog ID, and no unresolved slots. | The pair in finding 5 is not in any shipped preset. |
| 7 | Natural keys and duplicate handling already exist (table below). In-file duplicates: first row wins and later ones count as skipped. | Idempotency needs a canonical value in the key, not a new mechanism. |
| 8 | A re-import with a corrected weight is skipped, not updated. The same session under a different `workoutNum` is a separate row. | Stable IDs will not change either limit. |
| 9 | Programs spell one lift differently (`Bench P.`, `Bench Press`, `Squat`, `Back Squat`), and preset specs are served from code, not the database. | No single stored spelling matches every program, and a SQL-only migration can't see presets. |

| # | Table | Unique key | Write behaviour |
|---|-------|------------|-----------------|
| 1 | `lift_record` | userId, program, macrocycleNum, workoutNum, date, lift, occurrence, setNum | `createMany` with `skipDuplicates` |
| 2 | `training_max` | userId, program, lift | upsert |
| 3 | `strength_goal` | userId, program, lift | upsert |
| 4 | `custom_program_spec` | programId, week, offset, lift, order | Not part of these findings |
| 5 | `lift_metadata` | userId, lift | Not part of these findings |
| 6 | `workout_lift_override` | userId, program, macrocycleNum, workoutNum, lift, action | Not part of these findings |

### Where lift strings live

| # | Location | Items |
|---|----------|-------|
| 1 | Columns | `lift_record.lift`, `training_max.lift`, `training_max_history.lift` (no unique key), `strength_goal.lift`, `workout_lift_override.lift` and `.replacedBy`, `lift_metadata.lift` and `.substitutions` (`String[]`), `custom_program_spec.lift` |
| 2 | JSON | `focus_block.pool` (`lift`, `ruleLift`, `swapTo` per entry), `focus_day_state.state` (picks, trims, order), `import_batch.preImage` (keys embed the lift; undo parses them) |
| 3 | Code-defined | Preset specs in `packages/core/src/presets/index.ts` (a mix of slot and catalog names), `LIFT_NAMES`, `DEFAULT_LIFTS` in `onboarding/lib.ts`, `WARMUP_IMPLEMENT` on the workout page. The program editor picker and focus setup write catalog display names. `LiftPicker` offers `LIFT_NAMES` plus custom names. |
| 4 | Browser | `ll.timer.v1` (`settings.overrides` and `run.classifications` keyed by lift name, `run.on.lift`), `workout-draft:<program>:<mac>:<workout>:<lift>:<set>[~occ]` |
| 5 | URLs and API | `/macrocycle/n/workout/w/detail/[lift]`, `manage-lifts/edit/[lift]`, `strength-goals/:lift`, `lift-overrides/:lift`, `/lifts/:lift/metadata`. The `manage-lifts/edit` value is encoded and never decoded, which is why percent-encoded rows exist in `lift_metadata` and `muscles.ts` decodes them. |
| 6 | Public record ID | `${program}-${macrocycleNum}-${workoutNum}-${YYYYMMDD}-${lift}-${setNum}[~occurrence]` (D4) |
| 7 | Exact-string readers | Workout page and logger, history, `updateMaxes` and macrocycle generation, strength goals, muscle volume, focus (summary, select, plan), timer settings |

`.lift` appears about 570 times in 135 files, including tests. `apps/mobile` has no lift strings. Agent tools only pass lifts to the client.

## Proposed Solution

Every stored lift becomes a stable `LiftId`: a catalog ID or a custom lift's UUID. Display names are derived at the API boundary, and a program keeps its own wording in a label. One resolver turns any accepted spelling into a `LiftId`, so matching, re-import and rename all work the same way. A backed-up, resumable migration rewrites existing data in place and merges duplicates under the rules below. Work ships in seven deployable pull requests (PRs), and tolerant reads stay in place until production reports no unresolved values.

## Identity Model

| # | Decision | Detail |
|---|----------|--------|
| 1 | `LiftId` type | A catalog ID or a custom lift's UUID, as a branded TypeScript type. |
| 2 | One resolver | Follows the precedence `lookupLift` already has: reserved slot names mean the built-in, then the user's custom lifts, then catalog names, IDs and aliases. Decodes legacy percent-encoded names. Returns nothing for unknown text rather than guessing. |
| 3 | Display names | Derived from the ID at the API boundary. Responses return both `lift` and `liftName`. |
| 4 | Program wording | A new `custom_program_spec.label` column holds a program's own wording; presets keep theirs in code. A program that says `Squat` still shows `Squat`, while history shows the catalog name. |
| 5 | Catalog IDs | Permanent, with no foreign key because the catalog lives in code. A snapshot test fails if an ID is renamed or removed. |
| 6 | Modified lifts | A program doesn't affect how a lift is stored, and a modified lift is not a new catalog entry. At import, a row such as `OH Press-HV` can be kept as a custom lift, or as a modification of the existing lift once that separate design lands. |
| 7 | Custom lifts | Archived, not deleted, so history keeps a name. New column: `custom_lift.archivedAt`. |
| 8 | Column | `lift` keeps its name and is rewritten in place. |
| 9 | Alternative names | Each lift has one canonical name and ID, plus alternative names used only for matching (`Bench P.`, `Flat Bench Press`). |

| # | Rejected option | Reason |
|---|-----------------|--------|
| 1 | Parallel `liftId` column with dual writes | Every natural key would need rebuilding, and tolerant reads make the mixed state safe without it. |
| 2 | A lift table with foreign keys | The catalog lives in code and custom lifts have their own table. |
| 3 | General slot column for the overhead press pair | Identity would depend on the program. Custom programs repeating one lift already share one max and use `occurrence`. |
| 4 | A catalog entry for high-volume press (`overhead-press-hv`) | It is a modified lift, not a separate catalog lift, and the same case will recur for other lifts. |

## Delivery Plan

One top-level issue plus one sub-issue per PR, in milestone v0.4 — Alpha Release, epic API Implementation. Each PR is deployable alone. The decision record goes in `docs/adr/` as an Architecture Decision Record, ADR-041 if that number is still free when written.

| # | Pull request | Contents | Depends on | Rollback |
|---|--------------|----------|------------|----------|
| 1 | Matching fix and resolver ([#1118](https://github.com/merickvaughn/lifting-logbook/issues/1118), session already in progress) | Shared resolver in core. Matching fix at the workout max lookup, lift detail page and `updateMaxes`. | None | Revert |
| 2 | Tolerant reads everywhere ([#1135](https://github.com/merickvaughn/lifting-logbook/issues/1135)) | Every exact-string reader compares through the resolver. Queries by lift expand to all stored spellings. Import preview warns when two rows in one file resolve to the same key, and lets the user keep one as a custom lift. No stored data changes. | 1 | Revert |
| 3 | Names at the API boundary ([#1136](https://github.com/merickvaughn/lifting-logbook/issues/1136)) | Add `liftName` to responses. Add `custom_program_spec.label`. Web renders names rather than `lift`. | 1 | Revert; the column is additive |
| 4 | Archive custom lifts ([#1137](https://github.com/merickvaughn/lifting-logbook/issues/1137)) | Add `archivedAt`. Delete becomes archive. Archived lifts stay resolvable but are hidden from pickers. | 1 | Revert; the column is additive |
| 5 | Migration tool, not run for real ([#1138](https://github.com/merickvaughn/lifting-logbook/issues/1138)) | `apps/api/scripts/migrate-lift-ids.ts`, following the `seed-tm-history.ts` precedent (dry run, backup, restore, role check). Applies the merge rules and writes backup and review tables. Tested in the database end-to-end suite. | 1, 2, 3 | Revert; no data has been migrated |
| 6 | Cutover ([#1139](https://github.com/merickvaughn/lifting-logbook/issues/1139)) | All writers and pickers store IDs, including program and focus saves. Old URLs and old public record IDs are still accepted. Browser state is translated through the resolver when read. | 1, 2, 3, 4, 5 | Restore from backup while tolerant reads are still in place |
| 7 | Enforce and clean up ([#1142](https://github.com/merickvaughn/lifting-logbook/issues/1142)) | Repository ports take `LiftId`, so a raw string is a compile error. A report query counts stored values that aren't known IDs. Tolerant spelling expansion is removed; the resolver stays at import and for old URLs. A custom lift rename test proves history follows. D3 is struck in `docs/domain-model.md`. ADR written. | 6 | Revert; stored data is not changed by this PR |

PR 3 and PR 4 can run alongside each other.

**Decision gate after PR 5.** A dry run on staging, then on production, reports counts per table: rows rewritten, merged, sent to review and unresolved. The owner reviews those counts before PR 6 starts.

**Cutover order in PR 6.** Run the job on staging and verify. Run it on production. Rerun it after the new revision is live, to catch rows old revisions wrote during the rollout.

**Gate before tolerance is removed in PR 7.** Production has reported zero unresolved values, and the owner has cleared the review rows.

## Data Merge Rules

These apply when two rows resolve to the same key. "Review" means the row is saved to the review table.

| # | Data | Rule |
|---|------|------|
| 1 | `lift_record` | Identical weight, reps and notes: keep one. Different: keep the name-form row and send the other to review. The name-form row is probably the one logged by hand, since import is the main writer of IDs. This is a best guess because `lift_record` has no timestamp. |
| 2 | `training_max` | Keep the newest `dateUpdated` and send the other to review. Any `overhead-press` row whose program also has an `OH Press-HV` slot goes to review, because the slot can't be recovered. |
| 3 | `training_max_history` | No unique key. Rewrite only; no rows removed. |
| 4 | `strength_goal` | Identical: keep one. Different: keep the newest `updatedAt` and send the other to review. |
| 5 | `lift_metadata` | Decode percent-encoded names first. Identical: keep one. Different: keep the row whose lift exactly matches the catalog display name if any, otherwise review. Rewrite `substitutions` to IDs and deduplicate them. |
| 6 | `workout_lift_override` | Keep the newest `createdAt` for the same key. Rewrite `replacedBy`. |
| 7 | `custom_program_spec` | Rewrite `lift` to the ID and copy the old value to `label`. A key collision requires the same `order`, so it is expected to be rare. Send it to review rather than delete it. |
| 8 | `focus_block.pool`, `focus_day_state.state` | Rewrite values. Pool dedupe by lift keeps the first entry and sends the rest to review. |
| 9 | `import_batch.preImage` | Keys are not rewritten. Undo translates old keys through the resolver, matching the legacy-key fallback in `lift-record.repository.ts`. |
| 10 | Unknown text that resolves to nothing | Create a custom lift for that user with that name, classified by the existing custom-lift default, and log it in the job report. Do not leave free text behind. |

**Row-count invariant, per table:** rows before = rows after + rows merged away, and every merged-away row exists in backup.

## Migration Safety

| # | Concern | Decision |
|---|---------|----------|
| 1 | Backup | Before any write, per table, to a dated backup table with row-level security enabled and forced, like every other table. |
| 2 | Restore and rerun | Restore returns the captured state. Migrate and restore are idempotent. A rerun on migrated data changes nothing. |
| 3 | Database role | The production superuser migrator role bypasses row-level security. The runtime `lifting_app` role sees nothing without the per-request setting. Per `docs/deploy.md`, the migrator is the owner role and data migrations run under it. |
| 4 | Wrong connection | The script asserts the role with `SELECT current_user`. It aborts if it sees zero users, or zero rows where the expected count from a separate query is nonzero, so a wrong connection cannot look like a clean no-op. |
| 5 | Failure | One transaction per user, so a failure stops that user and leaves others intact. The job is resumable. |
| 6 | Query tracing | Prisma client calls rather than raw SQL where practical. Any `$queryRaw` or `$executeRaw` is wrapped in a manual span, since raw SQL is not auto-traced (ADR-024). |
| 7 | Logging | Counts per table and per user ID through structured logging. No lift payload beyond the unresolved names, and no secrets. |
| 8 | Rollout overlap | An old revision may write names after the job ran. Tolerant reads handle them and the rerun cleans them. |
| 9 | Review table | A report only, with no UI in this plan. |

## Risk Audit

| # | Dimension | Decision |
|---|-----------|----------|
| 1 | Testing | Database end-to-end tests under the restricted `lifting_app` role for app behaviour, per the repo's privilege-restricted test default. A migration test with fixtures covers every merge rule, including a zero-rows wrong-role failure. |
| 2 | Observability | The job logs per-table counts. No new runtime logging. |
| 3 | Security | Row-level security on new tables, tested under the restricted role. The resolver is isolated per user because custom lifts are per user. Large language model prompts keep seeing readable names only. |
| 4 | Resilience | Each PR is revertible. Cutover rollback is restore. Tolerant reads remain until PR 7. |
| 5 | Performance | One indexed custom-lift read per request for the resolver, cached within the request. History queries use expanded `IN` lists until PR 7. |
| 6 | Data integrity | Merge rules, the row-count invariant and backups. The migration becomes irreversible only if backup tables are dropped, which happens no sooner than after PR 7. |
| 7 | Experimental validity | N/A, no experiment. |
| 8 | Gate calibration | The PR 7 report query reports only and does not block. The snapshot test enumerates its own inputs. The job's zero-rows abort is calibrated with a known-good populated fixture and a known-bad wrong-role run. |
| 9 | Accessibility | Display text only. Names are unchanged where programs set their own label. |

## Acceptance Criteria

**Behaviour**

- [ ] A training max imported as `Bench P.` applies to a program whose lift is `Bench Press`: a test asserts the planned weight is computed from that max.
- [ ] Re-importing the same lift-record file with a mix of spellings creates 0 rows: database end-to-end test under `lifting_app`.
- [ ] Renaming a custom lift keeps its history, maxes and metadata: end-to-end test.
- [ ] Two rows in one file that resolve to one lift produce a preview warning, and keeping one as a custom lift stores both maxes: test with `OH Press` and `OH Press-HV`.
- [ ] A program that says `Squat` still shows `Squat`, and history shows `Back Squat`: Playwright or component test.
- [ ] One user's custom lift does not resolve for another user: test under `lifting_app`.

**Migration**

- [ ] A dry run reports counts per table and writes nothing: test asserts row counts and contents are unchanged.
- [ ] Each rule in Data Merge Rules produces its stated result: migration test with one fixture per rule.
- [ ] The row-count invariant holds for every table, and every merged-away row exists in backup: migration test.
- [ ] A rerun on migrated data changes nothing: test compares rows before and after.
- [ ] Restore returns the exact pre-migration rows: test compares restored rows to the captured fixture.
- [ ] Running with the wrong role aborts rather than reporting success: test asserts a failing exit and no writes.
- [ ] Backup and review tables have row-level security enabled and forced: test under `lifting_app`.

**Enforcement and records**

- [ ] The PR 7 report query, run against production, returns 0 stored values that aren't known IDs.
- [ ] Passing a raw string to a repository port is a compile error: a `// @ts-expect-error` test passes under `npm run typecheck`.
- [ ] Renaming or removing a catalog ID fails: snapshot test.
- [ ] An ADR for this decision exists under `docs/adr/`, and D3 is struck in `docs/domain-model.md`: both files show it.

## Out of Scope

- Redesigning the lift-record public ID beyond accepting old forms (D4).
- Updating rows on a corrected re-import.
- A review UI.
- Per-lift user renaming of catalog lifts.
- A catalog table in the database.
- `body_weight` (D6).
- Mobile.
- The modifications data model, marking a substitution during import (for example Romanian Deadlift in place of Deadlift) and assigning imported lifts to a program. These are being designed separately. This plan only guarantees that a modified row can stay separate as a custom lift.
- Merging semantically similar but distinct lifts, such as `Dip` and `Weighted Dip`.
- The per-entry alias and logger bodyweight decisions in [#1015](https://github.com/merickvaughn/lifting-logbook/issues/1015). The resolver reads aliases but does not change the logger's bodyweight check.

## Open Questions

| # | Question | Recommended answer |
|---|----------|--------------------|
| 1 | Does a modified lift share the base lift's training max or keep its own? | Decided by the separate modifications design. A custom lift keeps its own max today. |
| 2 | When two `lift_record` rows differ, is keep-name-form-and-review acceptable? | Yes. Two differing rows that are both name-form are not settled by this rule, so PR 5 must pick one deterministically and send the other to review. |
| 3 | Should the display-name decision in [#1120](https://github.com/merickvaughn/lifting-logbook/pull/1120) stand during the transition? | Yes. Those rows are converted by the job. |
| 4 | How many rows collide in production? | Not measured. The PR 5 dry run answers it. |
| 5 | What does a restore after cutover do with rows written after the backup, and with custom lifts the job created? | Not yet decided. Restore rewritten rows by primary key, leave newer rows in place for tolerant reads, and state the behaviour in PR 5. |
| 6 | Should a program keep its own wording, or always show the canonical name? | Not yet decided; settle it in PR 3. The label only affects display, never identity. Dropping it would be simpler, but a program that says `Squat` would show `Back Squat`. |

## References

- `docs/domain-model.md` (divergences D3, D4, D6)
- `docs/adr/ADR-010-multi-tenancy-data-isolation.md`
- `docs/adr/ADR-024-prisma-otel-sdk-override.md`
- ADR-027
- `docs/deploy.md`, section "Row-Level Security cutover"
- PostgreSQL documentation, Row Security Policies: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- Issue #1116: https://github.com/merickvaughn/lifting-logbook/issues/1116
- Issue #1118: https://github.com/merickvaughn/lifting-logbook/issues/1118
- Issue #1015: https://github.com/merickvaughn/lifting-logbook/issues/1015
- PR #1120: https://github.com/merickvaughn/lifting-logbook/pull/1120
