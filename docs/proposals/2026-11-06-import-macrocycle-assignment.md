# Proposal: Assign Imported Lift History to Macrocycles

**Status:** `draft`
**Date:** 2026-11-06
**Issue:** [#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170)

---

## Problem

The Consistent Intermediate Lifter migrating off a spreadsheet brings history with started-and-dropped programs, breaks, restarts and runs that went long. The import wizard can't represent any of that: the lifter picks one program for the whole file, must supply macrocycle and workout numbers as columns, and nothing reads the dates. Imported history therefore can't serve job J3 (track progress within a session or block), and it weakens job J2 (know what weight to use next session), because the record a lifter looks back on is grouped wrongly or can't be imported at all.

What the code does today:

| # | Today | Where |
|---|-------|-------|
| 1 | The wizard runs Source (program picker) → Analyzing → Classify → Map columns → Review → Preview → Done. No step groups rows into macrocycles. | `apps/web/app/(authed)/import/ImportWizard.tsx`, `steps.ts` |
| 2 | The user picks one program per wizard run and it overwrites every row, so history spanning several programs is forced into one. | `apps/api/src/programs/import-handlers.ts:73` |
| 3 | The `Program` column is still required, but its value is never stored. | `getRequiredFields`, `packages/core/src/utils/mapper/fuzzyColumnMapper.ts:107` |
| 4 | `macrocycleNum` and `workoutNum` are required file columns. Next is gated on required fields and there's no constant-value input, so a file without them can't be imported as lift history. Validation only checks that they're numbers. | Same line |
| 5 | Nothing infers boundaries from dates. `inferProgramFromLiftRecords` and `detectPresetSuperset` match on lift names only and have no non-test callers. | `packages/core/src/presets/index.ts:106-118` |
| 6 | `lift_record` has no foreign keys. `program` and `macrocycleNum` are required plain columns. The unique key is `(userId, program, macrocycleNum, workoutNum, date, lift, occurrence, setNum)`, and import writes through `createMany` with `skipDuplicates`. | `lift_record` model |
| 7 | A macrocycle is modeled as a sequence and exposed as a singleton. `macrocycle_dashboard` is one row per user and program, the dashboard returns 404 unless the number equals the current macrocycle, and there's no `GET /macrocycles`. | `docs/domain-model.md`, D9 |
| 8 | `training_max_history` has no `macrocycleNum`, and past macrocycle start dates are gone. | `docs/domain-model.md`, D14 |
| 9 | `getLiftRecords(program, macrocycleNum)` filters only on those two values, so imported rows with the same number as a live macrocycle come back mixed with live ones. | `apps/api/src/adapters/prisma/lift-record.repository.ts:20` |
| 10 | `workoutNum` is a global ordinal over the macrocycle. Program lengths are leangains 12 weeks, rpt 8 weeks and 5-3-1 12 weeks. | `programWorkoutKeys`, `packages/core/src/presets/programLengths.ts` |
| 11 | Import uses no large language model (LLM). The only LLM feature is the planning agent, which has no UI (D7). Its Anthropic and OpenAI-compatible adapters have no feature flag, no scrubbing of personal data, hand-written type guards and no check of lift names against the catalog. The OpenAI-compatible one defaults to Ollama at `http://localhost:11434/v1`. | `IMacrocyclePlanningAgent`, `apps/api/src/adapters/llm/`, ADR-016 |
| 12 | `agent-tools.ts` computes the previous macrocycle as `macrocycleNum - 1`. | `apps/api/src/adapters/llm/agent-tools.ts:68` |
| 13 | Commit re-parses the file on the server and never trusts the client preview. `ImportBatch` stores a pre-image for undo. | `import.controller.ts` |

## Proposed Solution

Add an Assign step between Review and Preview that groups imported lift history into macrocycles from its dates. It shows each stretch (a contiguous run of sessions the importer groups together) with its dates, the breaks around it and a suggested status, and the lifter can change any of them before commit. Rules produce the suggestions, so import works with no LLM configured. An optional LLM can add further suggestions, which count only if the lifter confirms them. Each confirmed stretch becomes a row in a new `macrocycle` table and shows up in a read-only list of past macrocycles. A break of more than two weeks usually means starting over, so the rules suggest a new macrocycle there and never insist on one. This classifies past history only: it doesn't adjust training maxes or the live plan after a break, and it generates no programming, so it stays clear of the two matching non-goals in the product requirements document.

### Delivery

Target milestone: v0.4 — Alpha Release. Five pieces follow this proposal, and their sub-issues hold the details.

| # | Piece | Needs |
|---|-------|-------|
| 1 | Macrocycle history model, `GET /programs/:program/macrocycles`, and a read-only past-macrocycles list | None |
| 2 | Rules version, as a pure `segmentLiftHistory` function in `packages/core` | None |
| 3 | Wizard Assign step and commit | 1 and 2 |
| 4 | LLM version | 3 |
| 5 | Comparison of the rules and LLM versions under `/experiment-audit` | 4 |

The comparison is pre-registered before either version's output is seen. The owner's hand-labelled sheet is the correct answer, with synthetic edge-case files alongside it.

### Testing the LLM version

Testing uses local Ollama, because it's free and history never leaves the machine. A local model says little about a paid hosted one, so any verdict holds for the local model only, and choosing a production provider is a separate decision after the comparison. Ollama's OpenAI compatibility page confirms JSON mode but doesn't mention `json_schema`, so responses are validated regardless.

### Prototype

The design of record is [`docs/proposals/assets/2026-11-06-import-macrocycle-assignment.prototype.html`](assets/2026-11-06-import-macrocycle-assignment.prototype.html). It shows the Assign step between Review and Preview: a timeline of stretches, breaks, status, editing a boundary, a conflict between the file and the dates, an unmatched program, and the rules-only and LLM-suggestion states. Boundary editing is keyboard-operable, and status is conveyed by more than color.

## Resolved Design Decisions

These are defaults pending the owner's review.

1. **A new `macrocycle` table holds the history.** Its columns are user, program, number, start date, end date, status (`completed`, `abandoned`, `overran`, `in-progress`) and origin (`imported`, `live`), plus the unmatched flag from decision 9. `macrocycle_dashboard` stays the pointer to the current one. Rejected: deriving macrocycles from `lift_record` dates alone, because status and an empty or unmatched stretch can't be stored or edited that way. Also rejected: widening `macrocycle_dashboard`, whose uniqueness is one row per user and program.
2. **Imported macrocycles are read-only history.** They never become current and never appear on live workout pages. Rejected: letting one become current, which would need a plan, schedule and overrides that never existed for it.
3. **Numbers become plain identifiers.** A new macrocycle takes the highest number for that user and program + 1, and order comes from the start date. That highest number has to count `lift_record` as well as `macrocycle`, because rows imported before this table exists carry numbers too. Starting the next live macrocycle follows the same rule, and `agent-tools.ts:68` changes as well, since `macrocycleNum - 1` no longer finds the previous one. Rejected: renumbering so numbers are chronological, because the number is denormalized onto five child tables plus the override tables and URLs, which makes undo much riskier. Also rejected: negative numbers, which leak into URLs and record ids.
4. **A gap of more than 14 days between sessions suggests a new macrocycle.** Exactly 14 days doesn't. Every suggestion is editable before commit. Rejected: a hard rule, since the owner said breaks "usually" mean starting over.
5. **A single-lift session inside a gap is flagged for the user to decide.** Rejected: silently ending the gap, or silently ignoring the session.
6. **Position comes from completed workouts, not calendar weeks.** A macrocycle past its expected length with workouts left is `overran`. Once all workouts are done, the next session starts a new macrocycle. A run that finishes every workout is `completed`, even if it finished late, and its dates show the lateness. A last stretch with workouts left that's still inside its expected length is suggested as `in-progress`, and under decision 2 it still doesn't become current. Rejected: calendar-only position, which misreads an interrupted or slow run.
7. **`abandoned` applies when workouts remain and the next stretch is a restart or a different program.** When `overran` and `abandoned` both fit, `abandoned` wins, because it says how the run ended, and the dates still show the overrun. Rejected: marking a run abandoned after a fixed time alone, because what ends a slow run is what comes after it, not how long it took.
8. **If the file has macrocycle numbers, keep them and flag any conflict with the dates.** A file number already used by another macrocycle for that user and program can't be kept. Assign flags it, and the stretch takes the next free number under decision 3. Rejected: dates always win, which would override the lifter's own record silently.
9. **Homemade or unmatched programs are stored under the program picked at the Source step.** They're flagged unmatched, with workouts numbered in session order. With no known length, the rules can't tell finished from unfinished, so Assign asks the user for the status. Rejected: an "unassigned" sentinel program, because `program` is a required string read everywhere. Also rejected: requiring a custom program first, which blocks import.
10. **Imports change current training maxes only through the existing split.** That's the row-level split that routes a one-rep-max test row to Training Maxes. Assign adds no other path. Rejected: setting current training maxes from the latest imported stretch, which would change the live plan from old data and cross the deload non-goal.
11. **The LLM sees per-session summaries: date, lifts, top set.** Notes are opt-in per import and off by default. Rejected: sending raw rows, which costs more and exposes free text.
12. **The LLM is off unless a provider is configured, and it only adds suggestions the user confirms.** It runs through a separate request, so the rules result never waits on it. Every suggestion is validated against the parsed rows, and invalid ones are dropped and counted. It's a new port with one structured call, not the planning agent's tool loop. Rejected: an LLM-first breakdown, and calling the LLM at commit, which could return something different from what the user confirmed.
13. **Duplicate detection for assigned imports doesn't depend on assigned macrocycle or workout numbers.** Re-importing the same file adds zero rows, even after the breakdown changes, and doesn't move rows already stored. `skipDuplicates` can't do this alone, because the unique key includes both numbers. A stretch whose rows are all duplicates creates no `macrocycle` row. Commit validates the user's confirmed breakdown against the re-parsed rows. Rejected: relying on the existing unique key, under which a changed breakdown would write every set a second time.

## Acceptance Criteria

### Rules version (`segmentLiftHistory`)

- [ ] Gaps of 13, 14 and 15 days: a core unit test asserts that only 15 starts a new stretch.
- [ ] An unfinished run: a core unit test asserts `abandoned` when the next stretch is a restart or a different program, and `in-progress` when it's the last stretch and still inside its expected length.
- [ ] An overrun: a core unit test asserts `overran` for a run past its expected length with workouts left, `completed` for a run that finished every workout late, and `abandoned` when the overrun is followed by a restart.
- [ ] A program switch with no gap: a core unit test asserts a new stretch starts at the switch.
- [ ] A lone session in a gap: a core unit test asserts it's returned as a flag for the user, with no boundary decided.
- [ ] Date-less rows: a core unit test asserts they're returned as unplaced and never guessed into a stretch.
- [ ] An unmatched program: a core unit test asserts workouts are numbered in session order and no status is suggested.

### Assign step and commit

- [ ] A file with no macrocycle or workout columns can be imported through the Assign step: `ImportWizard.test.tsx` reaches Preview with such a file, and an API end-to-end test commits it.
- [ ] A boundary can be edited by keyboard alone, and status is shown by text as well as color: a Playwright test edits a boundary using only key presses and asserts the status text.
- [ ] Commit stores the confirmed breakdown, and a breakdown that doesn't match the file is rejected: an API end-to-end test asserts the stored `macrocycle` rows in the first case and a 4xx response with no rows written in the second.
- [ ] Re-importing the same file adds zero rows, including after a changed breakdown: an API end-to-end test asserts unchanged `lift_record` and `macrocycle` counts in both cases.
- [ ] Undo removes the imported macrocycle rows and records: an API end-to-end test asserts both counts return to their pre-import values.
- [ ] A file number that conflicts with the dates, or that's already in use, is flagged: an API end-to-end test asserts the flag in the preview response and, for a number in use, that the committed stretch took the next free number.
- [ ] Import leaves current training maxes unchanged apart from split rows: an API end-to-end test asserts this for a file containing a break longer than 14 days.

### Macrocycle history

- [ ] An imported macrocycle doesn't appear on the live workout pages when its number differs from current, and never collides: an API end-to-end test asserts `getLiftRecords` for the current macrocycle returns no imported rows, and that the next live macrocycle's number is unused.
- [ ] `agent-tools.ts` finds the previous macrocycle by start date: a unit test with non-consecutive numbers asserts the right macrocycle is returned.
- [ ] Row-level security on the new table holds under the restricted role: a `*.db.e2e.spec.ts` suite running as that role asserts one user can't read or write another user's `macrocycle` rows.
- [ ] The past-macrocycles list shows imported macrocycles with status and dates: a Playwright test asserts both for a seeded imported macrocycle.
- [ ] `GET /programs/:program/macrocycles` returns macrocycles ordered by start date: an API end-to-end test asserts the order with non-chronological numbers.

### LLM version

- [ ] Import works with no LLM provider configured: an API end-to-end test with the provider unset completes preview and commit.
- [ ] Malformed, unknown-lift, out-of-range and timed-out LLM responses leave the rules result unchanged: adapter tests assert the rules result is identical and the dropped count is correct for each.
- [ ] The rules result doesn't wait on the LLM: `ImportWizard.test.tsx` shows the Assign step populated while the suggestion request is still pending.
- [ ] With notes opt-in off, the request to the provider contains no notes text: an adapter test asserts on the outgoing payload.
- [ ] No database transaction is held during the provider call: a service test with a fake provider asserts no transaction is open when the provider is called.

### Comparison

- [ ] The pre-registration is frozen before either version's output is seen: the tracking issue's pre-registration comment is dated before the first generated result.
- [ ] A `/experiment-audit verdict` result is recorded before any decision on keeping the LLM version: the results file named in the open questions contains the verdict.

## Out of Scope

- Adjusting training maxes or the plan after a break (non-goal: deload and missed-session recovery).
- Substitutions ([#1133](https://github.com/merickvaughn/lifting-logbook/issues/1133)). That issue also uses the word "assign", for a different thing: assigning lifts to what a program plans. This proposal assigns history to macrocycles.
- Mobile upload UI.
- Choosing a production LLM provider ([#136](https://github.com/merickvaughn/lifting-logbook/issues/136) covers tier-aware provider selection).
- Recomputing training max history per macrocycle (`docs/domain-model.md`, D14).
- Showing imported macrocycles on live workout pages.

### Related but separate

| # | Issue | Relation |
|---|-------|----------|
| 1 | [#1150](https://github.com/merickvaughn/lifting-logbook/issues/1150), [#1148](https://github.com/merickvaughn/lifting-logbook/issues/1148) | Import bugs, fixed on their own. |
| 2 | [#1113](https://github.com/merickvaughn/lifting-logbook/issues/1113) | Verifies Google Sheets import against the real logbook. It found no import requests in 30 days in production. |
| 3 | [#518](https://github.com/merickvaughn/lifting-logbook/issues/518) | LLM calls outside the row-level security transaction. The suggestion request follows the same constraint. |
| 4 | [#925](https://github.com/merickvaughn/lifting-logbook/issues/925) | Import endpoints hold a pooled connection during upload. A slow LLM call must not add to this, which is another reason it's a separate request. |

## Open Questions

- **Should a single history file be able to target several programs per stretch, given the Source step picks one?** Recommend yes, with a per-stretch override in Assign. Confirm at review.
- **Should the 14-day threshold be a per-user setting?**
- **Where do experiment results live, given `CLAUDE.md` has no `## Experiments` section?** Recommend `sessions/lifting-logbook/reports/`.
- **What should the migration do with lift records imported before the `macrocycle` table exists?** They have numbers but no row, so the past-macrocycles list wouldn't show them. Recommend one row per distinct number, with dates taken from its lift records. Their status can't be known, so that part needs a decision at review.

## References

- [`docs/domain-model.md`](../domain-model.md)
- [`docs/proposals/2026-06-09-smart-file-import.md`](2026-06-09-smart-file-import.md)
- [`docs/adr/ADR-016-cycle-planning-agent.md`](../adr/ADR-016-cycle-planning-agent.md)
- [`docs/adr/ADR-038-training-time-vocabulary.md`](../adr/ADR-038-training-time-vocabulary.md)
- [`docs/proposals/assets/2026-11-06-import-macrocycle-assignment.prototype.html`](assets/2026-11-06-import-macrocycle-assignment.prototype.html)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Prisma Client `createMany` reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany)
- [PostgreSQL row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
