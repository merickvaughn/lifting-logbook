# Proposal: Progression Type per Lift

**Status:** `accepted`
**Date:** 2026-11-10
**Issue:** [#1206](https://github.com/merickvaughn/lifting-logbook/issues/1206)

---

## Problem

The app has one way to move a training max. In a training week, if set 1 reaches the row's `reps`,
the max becomes that set's weight plus the row's `increment`; a test week takes the best final set;
a deload does nothing (`packages/core/src/services/maxes/updateMaxes.ts`). That rule suits the
built-in RPT and Leangains programs, but lifters don't progress every lift that way. A curl is
usually run on a rep range, a squat on straight sets, and some lifts aren't meant to move on their
own at all. Nothing on a lift says which, so the app can't plan or progress them differently.

Lifts outside the program make this worse. An extracurricular lift, or one imported from a stretch
of history whose program doesn't plan it, has no spec row, so there is no rule for it at all:
today it makes `updateMaxes` throw ([#1150](https://github.com/merickvaughn/lifting-logbook/issues/1150)).
The lifter has no way to say how such lifts should progress by default.

This serves J2 (know the weight: the plan follows how the lifter actually progresses each lift) and
J3 (track progress: off-program lifts progress instead of stalling or breaking recalculation).

## Proposed Solution

Every lift gets a **progression type**, with its own increment and, where the type needs one, a rep
range. The lifter can set it per lift and can set a **default progression** that applies to every
lift without its own value. A program's spec row can still override it inside that program.
`updateMaxes` then moves each max by its lift's type instead of by the single rule.

### Progression types

| # | Type | Rule for the training max | Source |
|---|------|---------------------------|--------|
| 1 | `linear` | When every set of the session reaches the target reps, the max becomes that weight plus the increment. A missed set holds the weight | Rippetoe, [Starting Strength](https://startingstrength.com/) |
| 2 | `double` | Work up a rep range at one weight. When every set reaches the top of the range, the max becomes that weight plus the increment, and the plan drops to the bottom of the range | Common practice (heuristic) |
| 3 | `amrap_gated` | Today's rule: in a training week, set 1 at or above the target reps makes the max that weight plus the increment | Heuristic; secondary summaries only |
| 4 | `percent_wave` | The plan is the training max times the wave's percentages. The max moves by the increment once, at the end of the wave. A wave is one pass through the spec's weeks: a program longer than its spec tiles those weeks, and each pass ends with the last workout of the spec's last week | Wendler, [5/3/1](https://www.jimwendler.com/) |
| 5 | `manual` | The lifter picks the load. The max never moves on its own | n/a |
| 6 | `rpe` | Load chosen to hit a target RPE. **In the shared vocabulary for focus blocks, which already use it; not selectable on a lift until per-set RPE logging exists** | [Zourdos et al. 2016](https://doi.org/10.1519/JSC.0000000000001049); [Helms et al. 2016](https://doi.org/10.1519/SSC.0000000000000218) |

Undulating periodization is a layout of weeks rather than a rule for choosing load, so it is
expressed as `percent_wave` ([Rhea et al. 2002](https://doi.org/10.1519/1533-4287(2002)016%3C0250:ACOLAD%3E2.0.CO;2)).

All test-week and deload behaviour is unchanged for every type: a test week takes the best final
set, a deload moves nothing, and a reduction is flagged for review rather than applied.

### Worked example

Squat on `linear`, max 100, increment 2.5, prescribed 3×5. Monday 5,5,5; Wednesday 5,5,3; Friday
5,4,3. Only Monday completes every set, so the max ends at 102.5. Under `amrap_gated`, which reads
only set 1, all three sessions qualify.

Cable Curl on `double`, range 8–12, at 30. Sessions log 12,11,10 then 12,12,12. The second session
completes the range, so the max becomes 32.5 and the next plan is 3×8 at 32.5.

### Which value applies

For a set, the progression type and rep range are the first found in this order:

1. **The program's spec row**, when it names one. Inside a program, the row wins.
2. **The lift's own value**, which the lifter set for this lift in Manage Lifts.
3. **The lifter's default progression**, from Settings, when set.
4. **The catalog's default** for a built-in lift.
5. **`amrap_gated` with `defaultWeightIncrement`**, the behaviour every lift has today.

The increment resolves separately. Inside a program, the spec row's `increment` always applies,
whatever type is resolved, because the column is required on every row. Off-program, it is the
lift's own increment, then the lifter's default's, then `defaultWeightIncrement`. The lifter's
default starts **unset**, so a new account uses the catalog's defaults. Once set, it
overrides the catalog for every lift without its own value, built-ins included. Clearing it returns
to the catalog's values.

### Storage

| # | What | Where | Notes |
|---|------|-------|-------|
| 1 | A lift's own progression | New nullable columns on `lift_metadata`: `progression`, `progressionIncrement`, `repsLow`, `repsHigh` | `lift_metadata` already holds one row per user per lift, built-in or custom, so Manage Lifts can set it for any lift. Inherits the table's row-level security |
| 2 | The lifter's default | `user_settings.defaultProgression`, nullable, with an optional default rep range | Unset means "use the catalog" |
| 3 | Built-in defaults | A `progression` entry on each lift in `packages/core/src/catalog/lifts.ts` | Code, not data |
| 4 | Spec-row override | Optional `progression` and `repsLow` on `LiftingProgramSpec` and `custom_program_spec` | The row's existing `reps` is the target, and the top of the range for `double` |

**Programs keep today's behaviour.** The built-in program presets set `amrap_gated` on every row, and
the migration backfills `amrap_gated` on every existing `custom_program_spec` row. Without that, a
lifter who set their default to `linear` would silently change how RPT progresses. A new custom row
may leave it blank and inherit from the lift. Re-tagging 5/3/1's rows as `percent_wave` is a separate
decision, not part of this proposal.

### Lifts with no spec row

An extracurricular lift, or an imported one outside its stretch's program, has no row, so its target
comes from the lift:

- `linear` and `amrap_gated` aim at the resolved `repsHigh`.
- `double` uses the resolved range.
- `percent_wave` has no wave to follow, so its max moves by the increment once at the end of the
  macrocycle it was trained in, when `startNewMacrocycle` runs.
- A type that needs reps with none resolved doesn't progress, and the result reports the lift, the
  same way [#1150](https://github.com/merickvaughn/lifting-logbook/issues/1150) reports a skipped
  record.

### Import

The Assign step ([#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170)) lists each lift
in a stretch that the stretch's program doesn't plan, with its progression preselected: the lift's
own value, else the lifter's default, else the catalog's. The lifter confirms or changes each before
the stretch counts as matched. A change is saved to the lift's `lift_metadata` row.

### Focus blocks

Focus blocks share the same vocabulary rather than keeping their own `FOCUS_PROGRESSIONS`. Stored
blocks migrate:

| # | Focus value today | Becomes | Why |
|---|-------------------|---------|-----|
| 1 | `double` | `double` | Same rule |
| 2 | `fixed` | `manual` | It plans the entry's weight as entered and never changes it |
| 3 | `tm` | `percent_wave` | It plans a percent of a training max with no rep gate |
| 4 | `rpe` | `rpe` | Same rule |

Focus entries then progress by their type, in their own phase after the lift-side work. Their
weights and maxes live in the `focus_block.pool` JSON, which `updateMaxes` never sees, so each type
needs its own trigger:

- A `double` entry's weight is derived when its prescription is built, from the `lastReps` the
  entry already carries: once every set reached `repsHigh`, the plan is the weight plus the
  increment at `repsLow`. Nothing extra is stored.
- A `percent_wave` entry's training max moves by the increment when the block's auto-roll
  successor is created on read, so the next block starts from the higher max. Example: a Biceps block runs Cable Curl on
`percent_wave`, max 60 at 80% for 10, increment 2.5. Every session in the block plans 47.5; when the
block ends the max becomes 62.5, so the next block starts at 50. Today it would stay at 47.5 forever.

### Relation to Lift Modifications ([#1140](https://github.com/merickvaughn/lifting-logbook/issues/1140))

| # | Issue | Overlap | How this proposal fits |
|---|-------|---------|------------------------|
| 1 | [#1153](https://github.com/merickvaughn/lifting-logbook/issues/1153) Own max and progression | Both change `updateMaxes`. #1153 decides **which** max a set moves (none, the lift's, or a modification's own). This proposal decides **when and by how much** | Orthogonal. An `own` modification's max follows its lift's resolved progression. The `updateMaxes` phase here lands after #1153 and keeps its three rules |
| 2 | [#1150](https://github.com/merickvaughn/lifting-logbook/issues/1150) No max or spec row throws | A lift with no row is exactly the off-program case above | The `updateMaxes` phase depends on #1150, so a lift without a row is skipped and reported before it is given a rule |
| 3 | [#1155](https://github.com/merickvaughn/lifting-logbook/issues/1155) Program slot start-on | Both add columns to `custom_program_spec`, `programSpecMapping` and the `ProgramEditor` row | Independent. Whichever lands second rebases its column onto the other |
| 4 | [#1154](https://github.com/merickvaughn/lifting-logbook/issues/1154) Import Review option | Both touch the import wizard | Different steps: #1154 is Review, this is Assign. No shared code |
| 5 | [#1152](https://github.com/merickvaughn/lifting-logbook/issues/1152) Logger toggle | It ships the `none` and `lift` rules in `updateMaxes`, the same function phase 3 changes | Phase 3 lands after it, as after #1153 |

Import segmentation (`packages/core/src/utils/import/segmentLiftHistory.ts`,
[PR #1202](https://github.com/merickvaughn/lifting-logbook/pull/1202)) already reads each program's
expected set order to decide where a stretch matches. A lift's progression type could later feed
that, for example a `double` lift's flat weights across sets. That is out of scope here.

### Sequence

One top-level issue, with a sub-issue per PR:

1. **Vocabulary and resolver.** The shared enum in `packages/types`, catalog defaults, and a pure
   `resolveProgression(row, liftMeta, userDefault, catalogLift)` in `packages/core`. No behaviour change.
2. **Storage and settings.** The `lift_metadata` and `user_settings` columns, the spec-row columns with
   the `amrap_gated` backfill, the API, the Settings default and the Manage Lifts editor.
3. **`updateMaxes` dispatch and the plan.** The five lift rules and the off-program targets, plus
   what the logger plans for each type. Today it plans the row's `reps` at a weight from the max. A
   `double` lift plans its range instead: the bottom right after a bump, otherwise last session's
   reps. An off-program `linear` or `amrap_gated` lift plans its `repsHigh`. Depends on #1150 and
   lands after #1152 and #1153.
4. **Import Assign confirmation.** Depends on the Assign step from #1170.
5. **Focus blocks.** The value migration and focus progression by type.

An ADR records the resolution order and the storage choice when phase 2 lands.

### Decisions made by the owner

On 2026-11-09 (recorded in the engineering journal report `2026-11-09-progression-type-decisions.md`):

| # | Decision | Answer |
|---|----------|--------|
| 1 | Where progression lives | A lift default plus an optional spec-row override; the row wins inside a program |
| 2 | Types in the first release | `linear`, `double`, `amrap_gated`, `percent_wave`, `manual`; `rpe` deferred until per-set RPE logging exists |
| 3 | Vocabulary | One shared enum with focus blocks |
| 4 | What the user default applies to | Every lift without its own value, including built-ins |
| 5 | Import of a lift outside the stretch's program | Assign preselects its progression and asks the lifter to confirm before the stretch counts as matched |
| 6 | `updateMaxes` | Dispatch on type in the first release |
| 7 | Increment | Per lift, stored with its type, falling back to `defaultWeightIncrement` |

On 2026-11-10, while drafting this proposal:

| # | Question | Answer |
|---|----------|--------|
| 8 | Is the user default optional? | Yes, unset at start, so catalog defaults apply until the lifter sets one |
| 9 | Where does `double`'s rep range come from? | The lift's setting, plus an optional `repsLow` on a spec row whose `reps` is the top |
| 10 | `percent_wave` with no spec row | The max bumps by the increment once at the end of the macrocycle |
| 11 | Focus `fixed` becomes | `manual` |
| 12 | Focus `tm` becomes | `percent_wave`, revising decision 3's earlier `amrap_gated` after a worked example |
| 13 | Focus blocks | Progress by their type too, not only renamed |
| 14 | Where a lift's own value is stored | `lift_metadata`, so built-ins can have one too, revising decision 1's "a column on custom lifts" |
| 15 | `linear` | Adds the increment only when every set of the session reaches the target |

### Risks by dimension

| # | Dimension | Decision |
|---|---|---|
| 1 | Testing | Unit tests per type in `updateMaxes` and the resolver; e2e for the new settings and lift fields; adapter tests for the backfill; an `ImportWizard` test for Assign |
| 2 | Observability | The off-program "no target" skip is reported in the result and logged with the lift id. Client writes go through `logClientError`. No raw SQL |
| 3 | Security | New columns sit on tables that already have forced row-level security (`lift_metadata`, `user_settings`, `custom_program_spec`). Enum values and rep ranges are validated in the DTOs |
| 4 | Resilience | Every column is nullable or backfilled, and a missing value falls through to today's rule, so a revert of the code leaves the data harmless |
| 5 | Performance | `lift_metadata` is already read per user; the resolver works on maps built once per `updateMaxes` call, as #983 did for maxes |
| 6 | Data integrity | The backfill keeps every existing program on `amrap_gated`. Focus values migrate in one statement, and the read DTO accepts the old values until it has run |
| 7 | Experimental validity | N/A: no comparative claim |
| 8 | Gate calibration | N/A: no gate. Import's preselection is a pre-fill the lifter confirms |
| 9 | Accessibility | The type picker is a labelled native select; the rep range inputs are labelled number fields |

## Acceptance Criteria

- [ ] Programs progress exactly as before. Check: every existing `updateMaxes` test passes unchanged, and a new test with the lifter's default set to `linear` asserts an RPT row still uses the set-1 rule.
- [ ] The resolution order holds. Check: `resolveProgression` unit tests cover a row value, a lift value, a user default, a catalog default and none, each winning over the ones below it, and the increment falling back to `defaultWeightIncrement` on its own.
- [ ] Each lift type moves the max by its rule. Check: `updateMaxes` tests run the Squat `linear` example to 102.5, the Cable Curl `double` example to 32.5, `manual` never moving, and `percent_wave` moving once per wave, including once per pass of a program that tiles its spec's weeks twice.
- [ ] The plan follows the type. Check: a logger test asserts the Cable Curl `double` plan reads 3×8 at 32.5 after the bump and last session's reps before it, and an off-program `linear` lift plans its `repsHigh`.
- [ ] Inside a program, the row's increment wins. Check: a `resolveProgression` or `updateMaxes` test gives a lift its own increment of 5 and a row increment of 2.5, and asserts 2.5 in the program and 5 off it.
- [ ] An off-program lift progresses by its own target. Check: an `updateMaxes` test with no spec row asserts `linear` aims at the lift's `repsHigh`, `percent_wave` bumps once at `startNewMacrocycle`, and a lift with no reps resolved is reported, not thrown.
- [ ] A lifter can set a lift's progression and their default. Check: e2e tests write and read `lift_metadata` progression fields for a built-in and a custom lift, set and clear `defaultProgression`, and reject an unknown type or `repsLow` above `repsHigh` with a 400.
- [ ] Another user's values are unreadable. Check: `rls.db.e2e.spec.ts` asserts the restricted role can't read another user's `lift_metadata` progression.
- [ ] The backfill keeps custom programs on today's rule. Check: a migration test asserts every pre-existing `custom_program_spec` row reads `amrap_gated`.
- [ ] Assign asks about each off-program lift. Check: an `ImportWizard` test with a stretch containing an unplanned lift asserts it is listed with its progression preselected, the stretch isn't matched until confirmed, and a change is saved to the lift.
- [ ] Focus blocks migrate without changing their plan. Check: a migration test turns `fixed` into `manual` and `tm` into `percent_wave`, and `prescribe` tests assert the same sets, reps and weights as before for each.
- [ ] Focus entries progress by type. Check: a `prescribe` test asserts a `double` entry whose `lastReps` all reached `repsHigh` plans the weight plus the increment at `repsLow`, and a focus test asserts the Biceps `percent_wave` example's auto-roll successor starts from 62.5.

## Out of Scope

- **Selecting `rpe` on a lift.** Needs per-set RPE logging first.
- **Re-tagging built-in programs**, such as 5/3/1 as `percent_wave`. Every preset stays `amrap_gated` here.
- **Feeding progression into import segmentation.** A possible later use, noted above.
- **Stall handling**, such as automatic deloads after repeated misses on `linear`. The lifter resets the max, as today.
- **The mobile app.** Settings and Manage Lifts there are a separate surface.
- **Charting progress by type.** The data allows it later.

## Open Questions

None blocking. The owner's answers are recorded under "Decisions made by the owner" above. Two
details are proposed here and confirmed at review: the off-program targets under "Lifts with no spec
row", and that an `own` modification follows its lift's progression.

## References

- [`docs/domain-model.md`](../domain-model.md): the training-max ladder and which levels are recomputed
- [`docs/standards/training-max-precision.md`](../standards/training-max-precision.md): directly-known maxes are never rounded; planned weights round to loadable plates
- [Lift Modifications proposal](2026-11-05-lift-modifications.md): the `updateMaxes` rules this builds beside
- [Assign Imported Lift History to Macrocycles](2026-11-06-import-macrocycle-assignment.md): the Assign step this extends
- [Focus Work proposal](2026-10-24-focus-work-accessory-blocks.md) and [ADR-039](../adr/ADR-039-focus-block-persistence.md): focus block storage
- Rippetoe, [Starting Strength](https://startingstrength.com/); Wendler, [5/3/1](https://www.jimwendler.com/)
- Zourdos et al. 2016, [Novel Resistance Training–Specific RPE Scale](https://doi.org/10.1519/JSC.0000000000001049); Helms et al. 2016, [Application of the RIR-Based RPE Scale](https://doi.org/10.1519/SSC.0000000000000218)
- Rhea et al. 2002, [A Comparison of Linear and Daily Undulating Periodized Programs](https://doi.org/10.1519/1533-4287(2002)016%3C0250:ACOLAD%3E2.0.CO;2)
