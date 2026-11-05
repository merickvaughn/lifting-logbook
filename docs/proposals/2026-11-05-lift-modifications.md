# Proposal: Lift Modifications

**Status:** `draft`
**Date:** 2026-11-05
**Issue:** [#1140](https://github.com/merickvaughn/lifting-logbook/issues/1140)

---

## Problem

A lifter often changes how they perform a lift without it becoming a different lift: a wider grip
on cable curls, or switching to a mixed grip for the last reps of a deadlift. The app has nowhere to
record that. It leaves two poor options, a free-text note or a new lift whose history is split from
the original.

Both show up in the real logbook, the `Lifting_Logbook_2026` workbook checked on staging in
[#1113](https://github.com/merickvaughn/lifting-logbook/issues/1113):

| # | What the logbook does today | Evidence | What it costs |
|---|---|---|---|
| 1 | A new name per variation | `Wide-Grip CBL Curls`: 12 rows, its own program slot, its own max of 65 (`CBL Curls` is 68.75) | History splits from Cable Curl, and import stops on the name until it is mapped ([#1114](https://github.com/merickvaughn/lifting-logbook/issues/1114)) |
| 2 | A free-text note per set | About 17 notes such as `plus 3 mixed` and `3 overhand, 4 mixed`, on Deadlift wherever checked; 3 about grip width, such as `switched to wide grip to address bicep width` | Can't be filtered or shown consistently. Reading meaning from notes is already a known defect ([D1](../domain-model.md#defects)) |

The note counts were read by eye from a one-time read of the sheet, not by script.

This serves J1 (log without friction: no retyping the same note), J2 (know the weight: a variation
with its own max plans from it) and J3 (track progress: variations stay with their lift).

## Proposed Solution

A **modification** is a description of a change to how a lift is performed, linked to that lift. A
lift can have several. Each can be toggled during a workout, and each logged set records which were
on. The set stays a set of the original lift. A modification can also have its own training max.

### What counts as what

Three concepts look alike. The test is whether it is still the same lift, and whether it is
performed the same way.

| # | Concept | Test | Example | What is stored |
|---|---|---|---|---|
| 1 | **Alternative name** | Exactly the same lift, under another name | `OH Press-HV`, `Bench P.` | Nothing new. The row is that lift |
| 2 | **Modification** | The same lift, performed differently | Wide grip on Cable Curl, Mixed grip on Deadlift | The lift, plus the modifications on each set |
| 3 | **Substitution** | A different lift takes its place | Romanian Deadlift for Deadlift | A different lift, with its own catalog entry, max and history |

Substitution is tracked separately in
[#1133](https://github.com/merickvaughn/lifting-logbook/issues/1133) and is out of scope here. The
two relate in four ways:

- They compose. A substituted lift can have its own modifications, such as Romanian Deadlift with
  Paused.
- A modification belongs to one lift, so it doesn't follow a swap. After a Manage Lifts `replace`,
  the logger offers the replacement's modifications, and slot start-on modifications don't apply.
- Sets already logged keep their modifications, under the lift they were logged against.
- `LiftMetadata.substitutions`, the free-text list on the lift editor, is unrelated to both and is
  unchanged.

### Decisions already made by the owner (2026-11-05)

| # | Question | Decision |
|---|---|---|
| 1 | Does a modified set move the training max? | Per modification |
| 2 | What weight does the logger plan? | A modification can have its own max |
| 3 | How do those two combine? | Three choices on each modification, listed below |
| 4 | Two modifications with their own max on one set? | One at a time. Turning one on turns the other off |
| 5 | Where is it recorded? | On each set |
| 6 | How does a toggle start? | A program slot can start it on; everything else starts off |
| 7 | `OH Press-HV`? | Exactly Overhead Press under another name. "HV" means high volume, which is why the weight is lower. It is **not** a modification |
| 8 | The high-volume slot's plan and flags? | Solved by a separate slot setting, in [#1141](https://github.com/merickvaughn/lifting-logbook/issues/1141) |

The three choices (`maxMode`):

| # | `maxMode` | Plans from | A qualifying set moves | Example |
|---|---|---|---|---|
| 1 | `none` (default) | The lift's max | No max | No chalk |
| 2 | `lift` | The lift's max | The lift's max | Mixed grip |
| 3 | `own` | Its own max | Its own max | Wide grip at 65 |

### Stored shape

Two new tables and three new columns. All additive.

```prisma
model LiftModification {
  id               String    @id @default(uuid())
  userId           String
  // The lift's LiftId from #1134: a catalog id or a custom lift's uuid. No foreign key, because
  // catalog lifts are not rows.
  lift             String
  name             String    // "Wide grip"
  description      String    @default("")
  // 'none' | 'lift' | 'own', with a CHECK constraint
  maxMode          String    @default("none")
  // Sheet spellings that mean this lift with this modification on. Matched on import.
  alternativeNames String[]
  archivedAt       DateTime?
  createdAt        DateTime  @default(now())
  maxes            LiftModificationMax[]

  @@unique([userId, lift, name])
  @@index([userId, lift])
  @@map("lift_modification")
}

// A modification's own training max, scoped to a program the way training_max is.
model LiftModificationMax {
  id             String           @id @default(cuid())
  userId         String
  program        String
  modificationId String
  weight         Float
  dateUpdated    DateTime
  modification   LiftModification @relation(fields: [modificationId], references: [id], onDelete: Cascade)

  @@unique([userId, program, modificationId])
  @@map("lift_modification_max")
}

// LiftRecord: the modifications on this set; empty means unmodified
modifications  String[] @default([])
// CustomProgramSpec: the modifications this slot starts with on
modifications  String[] @default([])
// TrainingMaxHistory: null is the lift's own history
modificationId String?
```

Both tables get forced row-level security with one isolation policy, in the migration that creates
them, like every other table.

**Rules the columns can't express, enforced on write in both adapters:**

- A logged set's modification ids must belong to the user and to the set's lift, with at most one
  `own`. Anything else is a 400.
- Modifications don't enter the set's natural key or public id. A set is still set N of that lift,
  so existing record ids and [D4](../domain-model.md#defects) are unaffected.
- Records hold ids, so a rename shows everywhere.
- Delete removes a modification no set or program row uses. Otherwise it archives: hidden from the
  toggles, still named in history.
- An alternative name can't be a name that already resolves to a lift, and a custom lift can't take
  a name that is already an alternative name. Both are a case-insensitive 409, matching the
  `canonicalAliasFor` guard.

**Writers that must carry the new data.** These name their fields or tables explicitly, so new data
would be lost or left behind with no error:

| # | Writer | What it does today | What it must do |
|---|---|---|---|
| 1 | `saveWorkout` (`workout.repository.ts`) | Deletes a workout's records and re-creates them from a fixed field list | Include `modifications`, or a save silently clears them |
| 2 | `deleteCurrentMacrocycle` (`macrocycle-generation.service.ts`) | Deletes a program's training maxes and history, through a `Pick<>` of named repositories | Also delete `lift_modification_max` for the program, or old own maxes reappear on the next macrocycle 1, the same defect as [D2](../domain-model.md#defects). Modifications themselves stay, because they belong to the user, like custom lifts |
| 3 | `deleteAllHistory` | Deletes a program's history | Keep deleting own-max history. The `modificationId: null` filter applies to reads only |
| 4 | `saveTrainingMaxes` callers in `macrocycle-generation.service.ts` | Save the maxes `updateMaxes` returns | Also save the own maxes it returns, in the same request transaction |

### Alternatives considered

| # | Alternative | Why not |
|---|---|---|
| 1 | Join table `lift_record_modification` instead of a `String[]` | Referential integrity, but every set read gains a join, and each bulk write gains a step: `createManyAndReturn`, which only returns the rows it created, then a second insert keyed on them. The schema already uses `String[]` this way, and the archive rule covers the dangling-id case |
| 2 | Record per lift per workout, in an override side-table | Owner decision 5. It can't show mixed grip on set 1 only |
| 3 | A `modification` column on `training_max` | More than 50 production files mention training maxes, and at least 8 look a max up by lift, such as `maxMap.get(wl.lift)` in the logger. A second row per lift could silently replace the lift's own max in those lookups unless every reader filters. It also changes the unique key, and a nullable column there doesn't enforce uniqueness in Postgres by default. The side table leaves those readers alone, at the cost of the writers listed under "Writers that must carry the new data" |
| 4 | A composite key in `training_max.lift` (`cable-curl~<id>`) | Needs no reader changes, but puts one more vocabulary in a column [#1118](https://github.com/merickvaughn/lifting-logbook/issues/1118) is trying to clean up, and raw keys would show up in max lists |
| 5 | Keep variations as separate custom lifts linked to a parent | That is today's split history plus a pointer, and it can't be toggled mid-workout |
| 6 | Parse existing notes into modifications | Repeats [D1](../domain-model.md#defects). `plus 3 mixed` and `no chalk` are read differently by a human and a regex |

### The toggle in the workout logger

In `apps/web/app/(authed)/macrocycle/[macrocycleNum]/workout/[workoutNum]/`:

- **Where.** `LiftView` shows a row of toggle buttons (`aria-pressed`) under the lift name, above
  the warm-ups, with a small **Add** button that creates one inline. A lift with no modifications
  shows only **Add**, so a workout with none costs no extra taps (J1). The description appears
  under a toggle while it is on.
- **What a toggle does.** It applies to this occurrence's sets not yet logged. Logged sets keep what
  they recorded. `createLiftRecord` sends the active ids, left out when empty, the way
  `withOccurrence` leaves out occurrence 0.
- **Own max.** Turning on an `own` modification turns off any other `own` one and re-plans the
  warm-ups and unlogged sets from its max. The page computes each plan up front, so the toggle
  needs no fetch. A weight the user already typed is kept, because it lives in the set's draft.
- **No own max entered yet.** The plan uses the lift's max with a hint saying so, and the first
  qualifying set sets the modification's max.
- **Start state.** The last logged set of this occurrence if there is one, so a reload continues
  where the lifter was. Otherwise the slot's start-on list, then off. A toggle changed before the
  first set is logged is kept in `localStorage` beside the set drafts and cleared by the existing
  finish sweep. A lost entry falls back to the start state.
- **Logged sets.** The summary reads `65 lbs × 10 · Wide grip`, on the logger and on the lift detail
  page. Editing a set shows its toggles, and saving sends them through `updateLiftRecord`.
- **Focus lifts.** Toggles label the set but don't re-plan it. A focus lift's weight comes from its
  block's progression, not from a training max.
- **A failed fetch.** The page shows no toggles and logs the failure, and sets still log. This is an
  error-swallowing fallback, so it needs the coverage in
  [`error-fallback-test-coverage.md`](../standards/error-fallback-test-coverage.md).
- **Timer.** It writes nothing ([ADR-035](../adr/ADR-035-client-side-rest-timer-state.md)) and
  gets no toggles. It plans from the slot's start state, through the same function as the detail
  page, so the two can't disagree the way
  [#966](https://github.com/merickvaughn/lifting-logbook/issues/966) did. A mid-workout toggle in the
  logger doesn't reach the timer.

### Progression

`updateMaxes` keeps its existing gates: set 1 of a first occurrence, reps met, newer than the max,
and a reduction is flagged rather than applied. What changes is which max a set moves:

1. Any `none` modification on: no max moves.
2. Otherwise, an `own` modification on: that modification's max moves. With no max yet, the set
   creates one at weight plus increment.
3. Otherwise, including no modifications at all: the lift's max moves, exactly as today.

A set whose modifications send it elsewhere no longer needs a lift max, so it must not hit today's
`Training max for lift … not found` throw. Own-max changes go to `training_max_history` with
`modificationId` set. The existing history reads filter on `modificationId: null` inside the
adapters, so charts of a lift's max don't change. Weekly set counts credit a modified set to its
lift, unchanged.

### The import option

In the Review step of `apps/web/app/(authed)/import/ImportWizard.tsx`, an unresolved row's "No
match" area today offers one outcome: create a new lift. It gains a second:

- **New lift.** Today's classification chips, unchanged.
- **Modification of a lift.** A lift input using the existing `lift-catalog` list, a name, an
  optional description, and the three `maxMode` choices, with `own` suggested when the sheet has a
  max for that name. For `Wide-Grip CBL Curls` the form suggests Cable Curl and `Wide-Grip`.

Mapping to an existing lift stays as it is, through the input above. That is the alternative-name
case. [#1133](https://github.com/merickvaughn/lifting-logbook/issues/1133) adds marking a
substitution to the same step.

**Creating it stores the sheet's spelling as an alternative name.** The wizard then treats the row
as resolved, exactly as it does for a lift created mid-import. Import resolves alternative names on
the server, through the one resolver in the
[stable-ID plan](https://github.com/merickvaughn/lifting-logbook/issues/1134) or, until that lands,
the import slot map from `buildImportSlotMap`
([PR #1120](https://github.com/merickvaughn/lifting-logbook/pull/1120)). The answer is the lift plus
the modification. So:

- A re-import of the same sheet resolves with no prompt, and its natural keys match.
- The commit request gains no new field, which avoids conflict with the transport change in
  [#1121](https://github.com/merickvaughn/lifting-logbook/issues/1121).
- `DEFAULT_SLOT_MAP` doesn't grow, so the decisions tracked in
  [#1015](https://github.com/merickvaughn/lifting-logbook/issues/1015) aren't affected.

The suggestion is only ever a pre-fill. It looks for a known lift name in the raw text and offers
the remainder as the modification name. It is wrong by design for names like `Incline Bench P.`,
where it would offer Bench Press plus `Incline` when Incline Bench Press is its own catalog lift
([#1116](https://github.com/merickvaughn/lifting-logbook/issues/1116)). So nothing is applied until
the user confirms, and the form opens only when the user picks this outcome.

**How each tab's rows are stored:**

| # | Tab | Row | Result |
|---|---|---|---|
| 1 | Lift history | `Wide-Grip CBL Curls`, set 1 | `lift` = the Cable Curl id, `modifications` = [Wide grip] |
| 2 | Training maxes | `Wide-Grip CBL Curls`, 65, `maxMode` `own` | `lift_modification_max`. The Cable Curl max is untouched |
| 3 | Training maxes | Same row, `maxMode` `none` or `lift` | A skip, listed with its reason. Never merged into the lift's max |
| 4 | Strength goals | A row naming a modification | A skip, listed with its reason |
| 5 | Program | `Wide-Grip CBL Curls` slot | `lift` = the Cable Curl id, `modifications` = [Wide grip] as start-on. The stable-ID plan's `label` column keeps the program's own wording |

**Collapsing names can collide.** Once `CBL Curls` and `Wide-Grip CBL Curls` share a `lift`, a file
with set 1 of each in one workout on one date has two rows with one natural key, and
`skipDuplicates` would silently drop one. Import assigns `occurrence`
([#1027](https://github.com/merickvaughn/lifting-logbook/issues/1027)) per spelling within a
workout: the plain name gets 0, then each other spelling in alphabetical order, so a re-import is
stable and the plain row still drives progression.

Undo covers rows 1 and 2. A modification created mid-import stays after an undo, as a custom lift
created mid-import does today.

### `OH Press-HV`

It stays an alternative name of Overhead Press, so `DEFAULT_SLOT_MAP`'s entry doesn't change and
this proposal stores nothing new for it. Three consequences:

- **Which max wins.** A file with both `OH Press` (103.75, 9/28/2026) and `OH Press-HV` (75,
  1/1/2024) now has one lift named twice. [PR #1129](https://github.com/merickvaughn/lifting-logbook/pull/1129)
  keeps the most recent, so 103.75 wins.
- **The stable-ID plan.** [PR #1145](https://github.com/merickvaughn/lifting-logbook/pull/1145) and
  a comment on [#1118](https://github.com/merickvaughn/lifting-logbook/issues/1118) still treat the
  two as things to keep separate. The owner's decision here is the later one and overrides that:
  they are one lift. The conflict is noted on both.
- **The slot's plan.** If the 5×12 slot returns (the sheet lists it at offset -1, which reads as
  parked), it plans from 103.75 though the last high-volume sets were around 90, and each run that
  hits its reps proposes cutting the max. That is what
  [#1141](https://github.com/merickvaughn/lifting-logbook/issues/1141) addresses.

The first real modifications are therefore Wide grip on Cable Curl (`own`, 65) and Mixed grip on
Deadlift (`lift`).

### Sequence

This builds on the [stable-ID plan](https://github.com/merickvaughn/lifting-logbook/issues/1134)
([PR #1145](https://github.com/merickvaughn/lifting-logbook/pull/1145)), which isn't built yet:

- **Blocked on [#1118](https://github.com/merickvaughn/lifting-logbook/issues/1118)**, that plan's
  first PR. `lift_modification.lift` stores a `LiftId` from the start, and checking a set against a
  modification's lift needs the shared resolver while `lift_record.lift` still holds mixed
  spellings.
- **Should follow its tolerant reads ([#1135](https://github.com/merickvaughn/lifting-logbook/issues/1135)).**
  A modification's history needs to follow its lift under any stored spelling.
- **Its migration tool ([#1138](https://github.com/merickvaughn/lifting-logbook/issues/1138)) must
  know about `modifications`** if phase 2 here ships first. Merge rule 1 calls two rows identical
  by weight, reps and notes, so it must compare `modifications` too, or a merge could drop them.
  The ids are uuids, so the tool has nothing to rewrite.
- **Alternative names.** The plan's model gives each lift alternative names used for matching. If
  those land in a table, `alternativeNames` should move there with an optional modification id,
  rather than keep two lists.

The import work also builds on [#1114](https://github.com/merickvaughn/lifting-logbook/issues/1114),
[#1116](https://github.com/merickvaughn/lifting-logbook/issues/1116) and
[#1121](https://github.com/merickvaughn/lifting-logbook/issues/1121).

On approval, the issue becomes a top-level issue with one sub-issue per PR:

1. **Stored shape and API.** Migration, port, both adapters, `lift_modification` routes under
   `apps/api/src/lifts/`, the record fields.
2. **Logger toggle and display.** No own max yet: `own` behaves as `none`.
3. **Own max and progression.** The side table, the shared plan function, `updateMaxes`, editing
   modifications and their max in `LiftEditor`.
4. **Import option.** The Review outcome, alternative-name resolution, the tab rules above.
5. **Program slot start-on.** The column, program-spec import, `ProgramEditor`.

An ADR records the storage decisions when the first PR lands. `docs/domain-model.md` is descriptive,
so it changes with the code, not now.

### Risks by dimension

| # | Dimension | Decision |
|---|---|---|
| 1 | Testing | Regression and e2e coverage per the criteria below. New endpoints get an in-memory e2e test in the same PR, per the repo's coverage rule |
| 2 | Observability | Client writes report through `logClientError`, with ids and never description text. No raw SQL, so no manual spans are needed |
| 3 | Security | Row-level security on both tables, tested under the restricted role ([#644](https://github.com/merickvaughn/lifting-logbook/issues/644)). Modification ids are checked against the user on write. Name and description are length-bound. `agent-tools.ts` isn't extended to send them to an LLM provider |
| 4 | Resilience | A failed fetch hides toggles and logging continues. Every migration step is additive, so rollback is a code revert |
| 5 | Performance | One indexed read per logger page. `ADD COLUMN … DEFAULT '{}'` doesn't rewrite `lift_record`. No index on the array until something filters by it |
| 6 | Data integrity | Existing rows default to empty and keep today's behavior. Production has no imported history (#1113 found no import requests in 30 days), so nothing needs converting |
| 7 | Experimental validity | N/A: no comparative claim |
| 8 | Gate calibration | N/A: no gate. The import suggestion is a pre-fill the user confirms |
| 9 | Accessibility | Toggles are real buttons with `aria-pressed` and a touch-sized target, at gym distance |

## Acceptance Criteria

- [ ] A lift can have several modifications, each with a name, description and `maxMode`. Check: an e2e test in `apps/api/src/lifts/` creates two on one lift, lists them, renames one, and gets a 409 on a duplicate name.
- [ ] A user can't read or attach another user's modification. Check: `rls.db.e2e.spec.ts` covers both tables under the restricted role, and a set naming another user's modification id gets a 400.
- [ ] Each logged set records its own modifications. Check: a logger test toggles one on after set 1, logs set 2, and asserts set 1's record has an empty list and set 2's has the id.
- [ ] A workout with no modifications is unchanged. Check: a logger test asserts a lift without modifications shows no toggles and sends no `modifications` field.
- [ ] A modification referenced by a set archives rather than deletes. Check: an e2e test deletes one, asserts it is gone from the toggle list, and that the set's response still names it.
- [ ] Turning on an `own` modification re-plans from its max and turns off another `own` one. Check: a logger test with two `own` modifications asserts the planned weights and the single active toggle. A typed weight survives.
- [ ] A set with two `own` modifications is rejected. Check: a `CreateLiftRecordDto` or controller test asserts a 400.
- [ ] Progression follows the three rules. Check: `updateMaxes` tests assert `none` moves nothing, `own` moves only its own max (including with no max yet), and `lift` or no modification moves the lift's max. Existing tests pass unchanged.
- [ ] A lift's max history is unaffected by own-max changes. Check: an adapter test asserts the existing history read excludes rows with a `modificationId`.
- [ ] Saving a workout keeps its sets' modifications. Check: a `saveWorkout` test in both adapters saves a record with a modification and reads it back.
- [ ] Deleting a macrocycle clears own maxes and keeps modifications. Check: a `deleteCurrentMacrocycle` test in both adapters asserts `lift_modification_max` and own-max history are empty for the program, and the modification still lists. A new macrocycle's `updateMaxes` save also persists own maxes.
- [ ] The Review step offers both outcomes for an unresolved row. Check: an `ImportWizard` test chooses "Modification of a lift" for `Wide-Grip CBL Curls`, with `createCustomLift` not called, and the row counts as resolved.
- [ ] A re-import resolves with no prompt and creates nothing new. Check: an `import.e2e.spec.ts` test imports a sheet twice and asserts the second run reports no unresolved rows and only skips.
- [ ] Rows that collapse onto one lift aren't lost. Check: an `import.e2e.spec.ts` test imports `CBL Curls` set 1 and `Wide-Grip CBL Curls` set 1 in one workout and asserts both are stored.
- [ ] A training-max row for a modification doesn't touch the lift's max. Check: an `import.e2e.spec.ts` test asserts `own` writes `lift_modification_max`, `none` is a skip with a reason, the Cable Curl max is unchanged in both, and undo restores the prior state.
- [ ] `OH Press-HV` stays Overhead Press. Check: the existing `liftCatalog.test.ts` case passes unchanged.
- [ ] A slot's start-on modifications survive a program edit. Check: a `programSpecMapping` round-trip test, plus a logger test where a slot starts Wide grip on and a `replace` override starts it off.
- [ ] On staging, the `Lifting_Logbook_2026` sheet imports `Wide-Grip CBL Curls` as a modification of Cable Curl. Check: a comment on this issue with the commit's status and trace ID. First delete the test custom lift of the same name left by #1113, or the row resolves to it and Review never asks.

## Out of Scope

- **Substitutions**, including marking one during import and assigning imported lifts to a program. Separate design.
- **Parsing existing notes into modifications.** Notes stay notes, including rep counts within a set like `3 overhand, 4 mixed`.
- **Converting an existing custom lift into a modification.** Not needed for the current data.
- **Built-in suggested modifications.** Modifications belong to the user. A catalog of common ones can come later.
- **Filtering or charting history by modification.** The ids are stored, so this can come later.
- **A modification changing muscle credit.** A modified set counts as its lift.
- **A load percentage on a modification.** Own max covers it.
- **The mobile app.** Logging there is a separate surface.
- **`OH Press-HV`'s plan and flags.** Tracked in [#1141](https://github.com/merickvaughn/lifting-logbook/issues/1141).
- **The export format.** The draft [Download My Data proposal](2026-08-26-download-my-data-export.md) will need a modifications column when it is built.

## Open Questions

None blocking. The product questions were put to the owner on 2026-11-05 and are recorded under
"Decisions already made" above. This design still needs the owner's approval before any of it is
built.

## References

- [`docs/domain-model.md`](../domain-model.md): the lift taxonomy, the name registries, and divergences D1, D3 and D4
- [ADR-035](../adr/ADR-035-client-side-rest-timer-state.md): the timer writes nothing
- [ADR-039](../adr/ADR-039-focus-block-persistence.md): the pattern for new user-scoped tables with forced row-level security
- [`docs/standards/training-max-precision.md`](../standards/training-max-precision.md): rounding for a plan computed from a modification's max
- [`docs/standards/error-fallback-test-coverage.md`](../standards/error-fallback-test-coverage.md): the fallback rule for a failed fetch
- PostgreSQL, [Arrays](https://www.postgresql.org/docs/current/arrays.html) and [Unique Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS) (null values are distinct by default)
- Prisma, [`createManyAndReturn`](https://www.prisma.io/docs/orm/reference/prisma-client-reference#createmanyandreturn) (the bulk write a join table would need)
