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
| 6 | `lift_record` has no foreign keys. `program` and `macrocycleNum` are required plain columns. The unique key is `(userId, program, macrocycleNum, workoutNum, date, lift, occurrence, setNum)`, and import writes through `createMany` with `skipDuplicates`. `occurrence` isn't parsed from files, so it's always 0 on import. | `lift_record` model, `LIFT_RECORD_HEADER_MAP` |
| 7 | A macrocycle is modeled as a sequence and exposed as a singleton. `macrocycle_dashboard` is one row per user and program, the dashboard returns 404 unless the number equals the current macrocycle, and there's no `GET /macrocycles`. | `docs/domain-model.md`, D9 |
| 8 | `training_max_history` has no `macrocycleNum`, and past macrocycle start dates are gone. | `docs/domain-model.md`, D14 |
| 9 | `getLiftRecords(program, macrocycleNum)` filters only on those two values, so imported rows with the same number as a live macrocycle come back mixed with live ones. | `apps/api/src/adapters/prisma/lift-record.repository.ts:21` |
| 10 | `workoutNum` is a global ordinal over the macrocycle. Program lengths are leangains 12 weeks and 36 workouts, rpt 8 weeks and 24 workouts, and 5-3-1 12 weeks and 24 workouts. | `programWorkoutKeys`, `packages/core/src/presets/programLengths.ts` |
| 11 | Import uses no large language model (LLM). The only LLM feature is the planning agent, which has no UI (D7). Its Anthropic and OpenAI-compatible adapters have no feature flag, no scrubbing of personal data, hand-written type guards and no check of lift names against the catalog. The OpenAI-compatible one defaults to Ollama at `http://localhost:11434/v1`. | `IMacrocyclePlanningAgent`, `apps/api/src/adapters/llm/`, ADR-016 |
| 12 | `agent-tools.ts` computes the previous macrocycle as `macrocycleNum - 1`, and it sends those records' notes to the provider. | `apps/api/src/adapters/llm/agent-tools.ts:68-72` |
| 13 | Commit re-parses the file on the server and never trusts the client preview. `ImportBatch` holds one program, and its pre-image is keyed by natural key. Undo deletes the `created` keys under that program. | `import.controller.ts:299-303` |
| 14 | New macrocycle numbers don't check for existing rows: the first is always 1, and the next is always the previous + 1. | `macrocycle-generation.service.ts:273`, `updateMacrocycle.ts:30` |
| 15 | Other paths reach any macrocycle number. `fromMacrocycleNum` feeds a past macrocycle's records to `updateMaxes`, `POST lift-records` takes any number, and deleting the current macrocycle deletes every lift record for the program. | `macrocycle-generation.service.ts:178-213` and `:336`, `lift-records.controller.ts:136` |
| 16 | Importing a one-rep-max row overwrites the training max with no date check. | `training-max.repository.ts:84` |
| 17 | The API has no rate limiting. | No match for throttling in `apps/api/src` or `apps/api/package.json` |

## Proposed Solution

Add an Assign step between Review and Preview that groups imported lift history into macrocycles from its dates. It shows each stretch (a contiguous run of sessions the importer groups together) with its dates, the breaks around it and a suggested status, and the lifter can change any of them before commit. Rules produce the suggestions, so import works with no LLM configured. An optional LLM can add further suggestions, which count only if the lifter confirms them. Each confirmed stretch becomes a row in a new `macrocycle` table and shows up in a read-only list of past macrocycles. A break of more than two weeks usually means starting over, so the rules suggest a new macrocycle there and never insist on one. This classifies past history only: it doesn't adjust training maxes or the live plan after a break, and it generates no programming, so it stays clear of the two matching non-goals in the product requirements document.

In this proposal, a session is every row with one date.

### Delivery

Target milestone: v0.4 — Alpha Release. Five pieces follow this proposal, and their sub-issues hold the details.

| # | Piece | Needs |
|---|-------|-------|
| 1 | Macrocycle history model, the backfill, `GET /programs/:program/macrocycles`, and a read-only past-macrocycles list | None |
| 2 | Rules version, as a pure `segmentLiftHistory` function in `packages/core` | None |
| 3 | Wizard Assign step, commit, and Undo from the past-macrocycles list | 1 and 2 |
| 4 | LLM version | 3 |
| 5 | Comparison of the rules and LLM versions under `/experiment-audit` | 4 |

The comparison is pre-registered before either version's output is seen. The owner's hand-labelled sheet is the correct answer, with synthetic edge-case files alongside it.

### Rollout and revert

1. Piece 1 ships first, with the new numbering rule and the backfill. It writes no imported rows, so it can be reverted until piece 3 is on.
2. Piece 3 sits behind `IMPORT_ASSIGN_ENABLED`, off by default. With it off, the wizard and commit behave as they do today. It goes on in staging first, then production.
3. Turning the flag off stops new assigned imports and leaves stored rows alone. That's the normal way back.
4. Reverting piece 1's code isn't safe once imported rows exist, because `prevNum + 1` can land on an imported number. Undo those batches first, or leave piece 1 in place.

### Testing the LLM version

Testing uses local Ollama, because it's free and history never leaves the machine. A local model says little about a paid hosted one, so any verdict holds for the local model only, and choosing a production provider is a separate decision after the comparison. Ollama's OpenAI compatibility page confirms JSON mode but doesn't mention `json_schema`, so responses are validated regardless. The same page says its OpenAI API can't set the context size, so testing uses a Modelfile with a known `num_ctx`, and the pre-registration records prompt size against it. I haven't tested what Ollama does with an over-long prompt.

### Prototype

The UI prototype is [`docs/mockups/import-macrocycle-assignment.html`](../mockups/import-macrocycle-assignment.html). It shows the Assign step between Review and Preview: a timeline of stretches, breaks, status, editing a boundary, a conflict between the file and the dates, rows with no date, an unmatched program, and the rules-only and LLM-suggestion states. Boundary editing is keyboard-operable, and status is conveyed by more than color. It governs the interface only. This proposal and `segmentLiftHistory` own the rules, and its sample data is one file, not a long one. It doesn't show a grown file, an already-imported stretch, a file number in use, a file with one-rep-max rows, or "Status unknown". [#1173](https://github.com/merickvaughn/lifting-logbook/issues/1173) and [#1171](https://github.com/merickvaughn/lifting-logbook/issues/1171) carry criteria for those.

### Observability

- **Logs:** counts only, following `import.controller.ts:255`: sessions, stretches, flags, changes the lifter made to the suggestions, rows skipped as duplicates, the provider, duration, tokens and suggestions dropped by reason. Prompts and responses are never logged.
- **Spans:** one around the provider call, and a manual one around any raw SQL, which isn't auto-traced ([ADR-024](../adr/ADR-024-prisma-otel-sdk-override.md)). The lock in decision 13 is raw SQL.
- **Client errors:** the suggestion, Assign and commit calls report failures through `logClientError`, so a failed suggestion request doesn't vanish into the Unavailable state.
- **Failed batch saves:** the existing silent catch at `import.controller.ts:670-675` stays only for flag-off imports. For assigned imports the failure fails the commit (decision 17).

## Resolved Design Decisions

These are defaults pending the owner's review.

1. **A new `macrocycle` table holds the history.** Its columns are user, program, number, start date, a nullable end date, status (`completed`, `abandoned`, `overran`, `in-progress`, `unknown`), whether the lifter chose that status, origin (`imported`, `live`, `legacy`) and the unmatched flag from decision 9, with a unique key on user, program and number. `macrocycle_dashboard` stays the pointer to the current one. Live macrocycles get a row when they're created, with `macrocycleDate` as the start date. Starting the next one closes the previous row: its end date is its last record's date, and its status comes from decisions 6 and 7. An `in-progress` row whose last session is more than 14 days old reads as `abandoned`, so it can't go stale. Rejected: deriving macrocycles from `lift_record` dates alone, because status and an empty or unmatched stretch can't be stored or edited that way. Also rejected: widening `macrocycle_dashboard`, whose uniqueness is one row per user and program.
2. **Imported macrocycles are read-only history.** They never become current and never appear on live workout pages. `currentMacrocycleOrFirst` falls back to macrocycle 1 when a program has no dashboard, so workout and focus routes treat an imported number 1 as having no live records. `fromMacrocycleNum`, `POST lift-records`, `PATCH lift-records/:id`, `POST lift-records/import` and flag-off commits reject an imported macrocycle with a 4xx, so its rows can't change training maxes or be edited one by one. The two import paths that take a number from a file create a `legacy` row for any number that has none. To correct imported history, undo the batch and import again: the past-macrocycles list offers Undo for the batches behind each imported macrocycle, through a new route that lists batches, since `batchId` otherwise lives only in the wizard. Deleting the current macrocycle removes `live` and `legacy` rows and their records, as Delete does today, and keeps `imported` ones, so history survives. Rejected: letting one become current, which would need a plan, schedule and overrides that never existed for it.
3. **Numbers become plain identifiers.** A new macrocycle takes the highest number for that user and program + 1, and order comes from the start date. That highest number counts `macrocycle`, `lift_record` and `macrocycle_dashboard`, so a live macrocycle with no sets isn't missed, nor are rows imported before this table exists. Import, `initializeFirstMacrocycle` and the next-macrocycle path all follow this rule, so a first live macrocycle after an import may not be number 1. That includes `fromMacrocycleNum`, which today gives source + 1 and can reuse a number: it now passes the allocated number to `updateMacrocycle`. Allocation happens under the lock in decision 13, and the unique key is the backstop: a conflict fails the write with a 409 and changes nothing. `agent-tools.ts:68` changes as well, since `macrocycleNum - 1` no longer finds the previous one, and it strips notes from `imported` and `legacy` rows, so they don't bypass decision 11. Rejected: renumbering so numbers are chronological, because the number is denormalized onto seven tables (`lift_record`, `macrocycle_dashboard`, `workout_date_override`, `workout_skip_override`, `workout_lift_override`, `focus_day_state`, `macrocycle_scheduled_workout`) and URLs, which makes undo much riskier. Also rejected: negative numbers, which leak into URLs and record ids.
4. **A gap of more than 14 days between sessions suggests a new macrocycle.** Exactly 14 days doesn't. Every suggestion is editable before commit. Rejected: a hard rule, since the owner said breaks "usually" mean starting over.
5. **A single-lift session inside a break is flagged for the user to decide.** A break here means a gap of more than 14 days when that session is left out. It sits outside every stretch with no boundary decided, and Continue stays blocked until the user files it with the earlier stretch, joins the stretches, or leaves it out. The same three choices apply when the gaps on both sides are over 14 days. A file with many flags gets one action that keeps every break and files each of those sessions with its earlier stretch. Rejected: silently ending the gap, or silently ignoring the session.
6. **Position comes from completed workouts, not calendar weeks.** `segmentLiftHistory` takes the import date. Completed workouts are distinct file workout numbers when the file has them, and sessions otherwise, so a double-session day or a sheet dated by week can undercount, and the lifter can change the suggested status. A macrocycle past its expected length with workouts left is `overran`. Once all workouts are done, the next session starts a new macrocycle. A run that finishes every workout is `completed`, even if it finished late, and its dates show the lateness. A last stretch with workouts left is `abandoned` if its last session is more than 14 days before the import date, the same break rule as decision 4. Otherwise it's `overran` or, inside its expected length, `in-progress`, and under decision 2 it still doesn't become current. A stretch the lifter joins past its program's length, or that mixes programs, gets no suggested status. Rejected: calendar-only position, which misreads an interrupted or slow run.
7. **`abandoned` applies when workouts remain and the next stretch is a restart or a different program.** A restart is any boundary between stretches of one program: a gap over 14 days, a file's workout number falling back to a lower one, or a boundary the lifter placed. A gap of 14 days or less with none of these is the same run resuming, not a restart. When `overran` and `abandoned` both fit, `abandoned` wins, because it says how the run ended, and the dates still show the overrun. Rejected: marking a run abandoned after a fixed time alone, because what ends a slow run is what comes after it, not how long it took.
8. **If the file has macrocycle numbers, keep them and flag any conflict with the dates.** A conflict is a gap of more than 14 days inside one file number, measured without any lone sessions. The file has already placed those sessions, so they aren't flagged under decision 5. A file number already used by another macrocycle for that user and program can't be kept. Assign flags it, and the stretch takes the next free number under decision 3. File numbers that share or interleave dates would overlap, so Assign flags them and blocks Continue until the lifter moves a boundary. Rejected: dates always win, which would override the lifter's own record silently.
9. **A stretch's program comes from the file, then the lifts, then the Source step.** The order is the file's `Program` column when it names a known program, then the smallest known program containing all the stretch's lifts, then the program picked at the Source step, which also settles a tie. `Program`, `macrocycleNum` and `workoutNum` become optional columns for assigned imports. A program switch is a change in that column between sessions or, with no column, a session with a lift outside the current program. Lift names can't show a switch to a program whose lifts are a subset of the current one (5/3/1's four lifts are inside both RPT and Leangains), so that takes a column, a break, or the lifter. A stretch is matched when all its lifts belong to a known program. Otherwise it's stored under the Source program and flagged unmatched. A file's workout numbers are kept. Without them, workouts are numbered in session order, and rows joining a stored run continue from its highest number. With no known length, the rules can't tell finished from unfinished, so Assign asks the user for the status. Rejected: an "unassigned" sentinel program, because `program` is a required string read everywhere. Also rejected: requiring a custom program first, which blocks import.
10. **Imports change current training maxes only through the existing split.** That's the row-level split that routes a one-rep-max test row to Training Maxes. It happens before segmentation, so those rows don't count as sessions. For assigned imports, a split row belongs to the program of the stretch covering its date, or else the Source program, and it's skipped and counted if it's older than that program's current max. Assign says how many rows would change a max. Assign adds no other path. Rejected: setting current training maxes from the latest imported stretch, which would change the live plan from old data and cross the deload non-goal.
11. **The LLM sees per-session summaries: date, lift names and top set.** Lift names come from the catalog, and custom lift names are replaced with placeholders, because they're free text. Notes are opt-in per import and off by default. A request carries at most 300 sessions and 2,000 output tokens. A file over that sends only the sessions around breaks, flags and unmatched stretches, and if those still don't fit, no request is made and the lifter is told. Rejected: sending raw rows, which costs more and exposes free text.
12. **The LLM is off unless a provider is configured, and it runs only when the lifter asks.** `IMPORT_SUGGESTIONS_PROVIDER` has no default, so nothing is called when it's unset, unlike the planning agent's factory. The Assign response says whether suggestions are available and from which provider, which is how the client tells Off from Unavailable. The lifter then asks once per import, seeing the provider's name and the notes choice first, and that holds for a local model too. It runs through a separate request, so the rules result never waits on it, with a 60-second deadline, no retries, and an abort when the lifter leaves the step. A wizard run reuses its result per file and notes choice, and each user gets 10 requests per hour, counted in Postgres because production runs several instances. Suggestions are anchored to session dates and re-validated when they arrive. Invalid or out-of-date ones are dropped and counted. It's a new port with one structured call, not the planning agent's tool loop. Rejected: an LLM-first breakdown, and calling the LLM at commit, which could return something different from what the user confirmed.

    | # | Suggestion kind | What accepting it does |
    |---|-----------------|------------------------|
    | 1 | `boundary` | Adds or removes a boundary at a session date |
    | 2 | `lone` | Answers a decision 5 flag |
    | 3 | `status` | Sets a stretch's status |
    | 4 | `program` | Sets a stretch's program |
    | 5 | `note` | Nothing: a note can only be dismissed |

13. **Duplicate detection for assigned imports counts rows, without assigned numbers.** It compares the file with what's stored for the user, under any program, per `(date, lift, setNum)`, with lift names compared through `liftSpellings`, and adds only the rows beyond the stored count. Rows with identical weight and reps pair first, so the rows left over are the real extras. Re-importing the same file adds zero rows, even after the breakdown or a stretch's program changes, and doesn't move rows already stored. Two same-day workouts stay separate, because the second counts as an extra row and takes the highest stored `occurrence` for its key + 1, so the unique key holds, even after an out-of-order undo. An exact repeat within one file, with the same weight and reps, counts once and is reported as skipped, as it is today. A re-exported row whose weight or reps changed is left as stored, and Preview shows how many differ. A stretch whose rows are all duplicates creates no `macrocycle` row. `skipDuplicates` can't do this alone, because the unique key includes both numbers, so commits and number allocation take `pg_try_advisory_xact_lock` per user. A second writer gets a 409 at once and can retry, because waiting would spend a 30-second transaction budget that already includes the upload. The lookup uses the existing `(userId, lift, date)` index unless the query plan at the row limit shows it needs another. Rejected: relying on the existing unique key, under which a changed breakdown would write every set a second time. Also rejected: leaving out `setNum` or counting per program, which would merge sets or re-import them after a program change.
14. **A file that has grown extends what's stored.** New rows join a stored imported macrocycle when they're under its program, it has workouts left, and no boundary from decisions 4, 6 or 7 falls between them. They take its number and update its end date. Assign shows these as "N new workouts join macrocycle X", and a stretch with nothing new as already imported. New rows that overlap more than one stored macrocycle, or one under another program, form their own macrocycle, and Assign says the dates overlap. Undo recomputes rather than restores: undoing any batch removes that batch's rows, removes macrocycle rows left with no lift records except a live one, and recomputes dates and suggested status from the rows that remain, keeping a status the lifter chose. A batch keeps its macrocycle changes in a separate field from its lift-record keys. Rejected: always forming a second macrocycle, which splits one real run, and restoring a stored pre-image, which is wrong once a later batch has added rows.
15. **One file can target a different program per stretch.** Assign has a program control on each stretch, and history spanning programs is the point of this proposal. So the batch records program with each key, and undo and duplicate lookup work across programs. Old batches stay readable and undo as before. Rejected: one program per file, which leaves row 2's problem in place.
16. **Assign gets its data from a new `mode=assign` call.** It re-parses the file with Review's exclusions and overrides, then returns stretches, flags, rows with no date, and how many rows would change a training max. When the macrocycle and workout columns are unmapped, Review doesn't flag those fields, and existing-record lookup waits until Assign. Rows with no date can't be stored, so they're left out and counted rather than held by the wizard's incomplete-row gate, and the lifter can go back to Review to fix or exclude them. Changing anything at Review discards Assign's edits with a notice, the way `reviewEditsDiscarded` works today. The `mode=preview` response tells the wizard whether `IMPORT_ASSIGN_ENABLED` is on, so Map columns knows which columns to require. Rejected: returning stretches from `mode=preview`, which runs before Review and can't see its exclusions.
17. **`mode=dry-run` and commit take the confirmed breakdown as session dates in the request body.** Row positions shift during commit, so dates are the stable key, and `excludeKeys` already travels this way. Each re-parses the file and validates the breakdown against it, in place of the strict number checks in `resolveCommitRows`. A lone session the lifter left out travels as an excluded date. A date outside every stretch, or overlapping stretches, gets a 4xx naming the problem, and the wizard returns to Assign with a fresh result. Commit is all-or-nothing, and that includes the batch save, which is otherwise the only way to correct these rows. Rejected: row indexes, and calling the rules again at commit, which could drop the lifter's edits.
18. **Existing records get `macrocycle` rows through a backfill in piece 1.** There's one row per distinct user, program and number across `lift_record` and `macrocycle_dashboard`, with dates from its lift records. The current number is `live` with status `in-progress`, and it takes its start date from `macrocycleDate`, so it works with zero records. `lift_record` has no origin column, so other numbers can't be told apart: they're `legacy` with status `unknown`, shown as "Status unknown" and not read-only. Finding the previous macrocycle by start date works from these rows. A number that already mixes imported and live rows stays mixed. [#1113](https://github.com/merickvaughn/lifting-logbook/issues/1113) found no import requests in 30 days, so few are expected. Rejected: guessing origin from `ImportBatch`, whose rows are deleted on undo and may be missing.

## Acceptance Criteria

The sub-issues carry these criteria. Until the owner's review ends, this section is the source and the sub-issues are updated from it. After that, the sub-issues are the source and this section is a snapshot.

### Rules version (`segmentLiftHistory`)

- [ ] Gaps of 13, 14 and 15 days: a core unit test asserts that only 15 starts a new stretch.
- [ ] An unfinished run: a core unit test asserts `abandoned` when the next stretch is a restart or a different program, `in-progress` when it's the last stretch and still inside its expected length, and `abandoned` when the last session is more than 14 days before the import date.
- [ ] A restart: a core unit test asserts `abandoned` when a file's workout number falls back, and that a 10-day gap with no fallback continues the same stretch.
- [ ] An overrun: a core unit test asserts `overran` for a run past its expected length with workouts left, `completed` for a run that finished every workout late, and `abandoned` when the overrun is followed by a restart.
- [ ] A finished run: a core unit test asserts the session after the last workout starts a new stretch with no gap.
- [ ] A program switch with no gap: core unit tests assert a new stretch starts at the switch with a `Program` column, and from a lift outside the current program, and that a move to a subset program (RPT to 5/3/1) with no column doesn't start one.
- [ ] Program precedence: a core unit test asserts the file's column beats the lifts, the lifts beat the Source program, and a tie goes to the Source program.
- [ ] Workout numbering: a core unit test asserts a file's numbers are kept, session order is used without them, and completed workouts count distinct file numbers when present.
- [ ] A lone session in a gap: a core unit test asserts it's returned as a flag for the user, outside every stretch, including when the gaps on both sides are over 14 days.
- [ ] Date-less rows: a core unit test asserts they're returned as unplaced and never guessed into a stretch.
- [ ] An unmatched program: a core unit test asserts workouts are numbered in session order and no status is suggested.

### Assign step and commit

- [ ] A file with no program, macrocycle or workout columns can be imported through the Assign step: `ImportWizard.test.tsx` reaches Preview with such a file and shows no number errors at Review, and an API end-to-end test commits it.
- [ ] With `IMPORT_ASSIGN_ENABLED` off, import behaves as today: the existing `import.e2e.spec.ts` suite passes unchanged with the flag unset, `ImportWizard.test.tsx` shows the old required columns, and an API end-to-end test asserts a flag-off commit can't write into an imported number.
- [ ] A boundary can be edited by keyboard alone, and status is shown by text as well as color: a Playwright test presses the same control twice using only key presses, asserts focus stays on it, asserts each control's name includes its stretch, and asserts the status text.
- [ ] Commit stores the confirmed breakdown, and a breakdown that doesn't match the file is rejected: an API end-to-end test asserts the stored `macrocycle` rows in the first case, and in the second a 4xx response with no rows written. `ImportWizard.test.tsx` asserts the wizard returns to Assign.
- [ ] Changing rows at Review discards Assign's edits: `ImportWizard.test.tsx` asserts the notice and a fresh Assign result.
- [ ] Re-importing the same file adds zero rows, including after a changed breakdown or a changed program: an API end-to-end test asserts unchanged `lift_record` and `macrocycle` counts in each case.
- [ ] Two workouts on one date both survive: an API end-to-end test imports them, asserts every set is stored, re-imports, and asserts zero new rows. It also undoes a first batch, re-imports, and asserts no row is lost or left behind.
- [ ] Duplicate detection compares what it says: an API end-to-end test asserts `bench-press` and `Bench Press` match, an exact repeat in one file is skipped and reported, and a changed row stays as stored and is counted in Preview.
- [ ] Two concurrent commits don't write twice: a `*.db.e2e.spec.ts` test runs both and asserts one gets a 409 and each set is stored once.
- [ ] A file that has grown extends its macrocycle: an API end-to-end test asserts the new rows take its number and update its end date, that a stored finished run isn't extended, that a stretch with nothing new reads as already imported, and that an overlap with another program forms its own macrocycle.
- [ ] Undo holds across batches and programs: API end-to-end tests undo three batches out of order on a two-program file and assert rows, dates and a status the lifter chose after each, with both counts back at their pre-import values at the end.
- [ ] Undo is reachable later: a Playwright test imports, leaves the wizard, undoes from the past-macrocycles list, and asserts the rows are gone.
- [ ] A file number that conflicts with the dates, or that's already in use, is flagged: an API end-to-end test asserts the flag in the `mode=assign` response and, for a number in use, that the committed stretch took the next free number. `ImportWizard.test.tsx` asserts file numbers that overlap block Continue.
- [ ] Rows with no date are left out and counted: an API end-to-end test asserts the count in the response and that the other rows commit, and `ImportWizard.test.tsx` asserts they don't hold the wizard at the incomplete-row gate.
- [ ] Import leaves current training maxes unchanged apart from split rows: an API end-to-end test asserts this for a file containing a break longer than 14 days. On a two-program file it asserts a split row changes the max of the program covering its date, a row older than that max is skipped and counted, and Assign reports the count.
- [ ] Commit is all-or-nothing at the row limit: `*.db.e2e.spec.ts` tests force the macrocycle insert and the batch save to fail and assert nothing is written, and a 5,000-row commit against existing history finishes inside the 30-second import transaction, with its duration in the test output.
- [ ] A long file stays workable: a Playwright test at 375px wide with 30 stretches and 20 flags asserts no horizontal page scroll, settled stretches collapsed to one line each, and one action that keeps every break and files those sessions with the earlier stretch.
- [ ] Status colors are distinct in every theme: a guard like `scripts/check-timer-phase-colors.mjs` runs in CI and fails on a collision between status tokens.

### Macrocycle history

These tests seed `imported` rows directly, because piece 1 writes none itself.

- [ ] An imported macrocycle doesn't appear on the live workout pages, and never collides: an API end-to-end test asserts `getLiftRecords` for the current macrocycle returns no imported rows, that `GET workouts/1` shows no imported sets when the program has no dashboard, and that the next live macrocycle's number is unused, including when the current macrocycle has zero records.
- [ ] Every path that creates a macrocycle follows the numbering rule: an API end-to-end test seeds an imported macrocycle, initializes, starts the next, and starts one with `fromMacrocycleNum`, and asserts distinct numbers and a `macrocycle` row for each.
- [ ] A live macrocycle's row stays correct: an API end-to-end test asserts starting the next one closes the previous row with an end date and status, and a unit test asserts an `in-progress` row over 14 days old reads as `abandoned`.
- [ ] Concurrent writers can't share a number: a `*.db.e2e.spec.ts` test inserts a duplicate user, program and number, and asserts a 409 with no rows written.
- [ ] Imported macrocycles can't be written to: API end-to-end tests assert a 4xx from `fromMacrocycleNum`, `POST lift-records`, `PATCH lift-records/:id` and `POST lift-records/import` on an imported macrocycle, and that training maxes don't change. A `legacy` macrocycle stays writable.
- [ ] A file number with no row gets one: an API end-to-end test asserts `POST lift-records/import` with a new number creates a `legacy` row.
- [ ] Deleting the current macrocycle leaves history: an API end-to-end test asserts `imported` rows and their records survive, and `live` and `legacy` ones are removed.
- [ ] The backfill gives every existing number a row: a `*.db.e2e.spec.ts` test seeds rows, runs the backfill, and asserts one row per number, `live` for the current one with a start date even with zero records, and `legacy` with `unknown` status for the rest, shown as "Status unknown" in the list. Undoing an old batch afterward leaves no macrocycle row without records.
- [ ] `agent-tools.ts` finds the previous macrocycle by start date and leaves out notes it can't vouch for: a unit test with non-consecutive numbers asserts the right macrocycle is returned with no notes on `imported` or `legacy` rows.
- [ ] Row-level security on the new table holds under the restricted role: a `*.db.e2e.spec.ts` suite running as that role asserts one user can't read or write another user's `macrocycle` rows.
- [ ] The past-macrocycles list shows imported macrocycles with status and dates: a Playwright test asserts both for a seeded imported macrocycle.
- [ ] `GET /programs/:program/macrocycles` returns macrocycles ordered by start date: an API end-to-end test asserts the order with non-chronological numbers.
- [ ] The decision is recorded: `docs/domain-model.md` no longer lists D9's sequence model as current and says "seven child tables" instead of "five", and an ADR under `docs/adr/` records the table and numbering rule.

### LLM version

- [ ] Import works with no LLM provider configured: an API end-to-end test with `IMPORT_SUGGESTIONS_PROVIDER` unset completes preview and commit, and asserts no outbound provider call and a response saying suggestions are off.
- [ ] Nothing is sent until the lifter asks: `ImportWizard.test.tsx` asserts no suggestion request before the button is pressed, and that the provider's name and notes choice are shown first.
- [ ] Malformed, unknown-lift, out-of-range and timed-out LLM responses leave the rules result unchanged: service tests against parsed rows assert the rules result is identical and the dropped count is correct for each.
- [ ] Each suggestion kind does what decision 12 says: `ImportWizard.test.tsx` asserts accepting each, and that a note has no Accept button.
- [ ] A late response can't change a breakdown the lifter has edited: `ImportWizard.test.tsx` moves a boundary while a request is pending and asserts out-of-date suggestions are dropped and counted, and that leaving the step aborts the request.
- [ ] The rules result doesn't wait on the LLM: `ImportWizard.test.tsx` shows the Assign step populated while the suggestion request is still pending.
- [ ] The outgoing request holds only what decision 11 lists: an adapter test asserts the payload against an exact allow-list, with notes opt-in off and on, and a custom lift name replaced by a placeholder.
- [ ] Prompts and responses aren't logged: a service test asserts neither appears in log output, and that the counts from the Observability section do.
- [ ] Limits hold: API end-to-end tests assert that an 11th request in an hour makes no provider call, that a file over 300 sessions sends only the sessions around breaks, flags and unmatched stretches, and that one still over the limit makes no call. `ImportWizard.test.tsx` asserts a second request for the same file and notes choice reuses the result.
- [ ] The provider call is observable: a service test asserts the span around it and the counts logged on success and failure.
- [ ] No database transaction is held during the provider call: a service test with a fake provider asserts no transaction is open when the provider is called.

### Comparison

- [ ] The pre-registration is frozen before either version's output is seen: the tracking issue's pre-registration comment is dated before the first generated result, and records prompt size against the model's `num_ctx`.
- [ ] A `/experiment-audit verdict` result is recorded before any decision on keeping the LLM version: [#1175](https://github.com/merickvaughn/lifting-logbook/issues/1175) links the engineering-journal file `sessions/lifting-logbook/reports/YYYY-MM-DD-macrocycle-assignment-comparison.md`, dated the day of the verdict, which contains it.

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

- **Should the 14-day threshold be a per-user setting?**

## References

- [`docs/domain-model.md`](../domain-model.md)
- [`docs/proposals/2026-06-09-smart-file-import.md`](2026-06-09-smart-file-import.md)
- [`docs/adr/ADR-016-cycle-planning-agent.md`](../adr/ADR-016-cycle-planning-agent.md)
- [`docs/adr/ADR-024-prisma-otel-sdk-override.md`](../adr/ADR-024-prisma-otel-sdk-override.md)
- [`docs/adr/ADR-038-training-time-vocabulary.md`](../adr/ADR-038-training-time-vocabulary.md)
- [`docs/mockups/import-macrocycle-assignment.html`](../mockups/import-macrocycle-assignment.html)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [Prisma Client `createMany` reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmany)
- [PostgreSQL row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
