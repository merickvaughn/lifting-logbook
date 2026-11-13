# Proposal: Offer to Set Up a Training Max for a Lift That Has None

**Status:** `accepted`
**Date:** 2026-11-12
**Issue:** [#1246](https://github.com/merickvaughn/lifting-logbook/issues/1246)

---

## Problem

A lifter can log sets for a lift that has no training max. This happens when they import history for
a lift the program doesn't plan, swap a lift in with Manage Lifts, or add one to a workout.
Since [#1150](https://github.com/merickvaughn/lifting-logbook/issues/1150), progression skips such a
lift and reports it in `skipped` with reason `no-training-max`, so it never progresses. The workout
pages plan it from a max of 0. Nothing in the app tells the lifter, and they have no way to fix it:
Settings → Training Maxes lists only lifts that already have a max.

## Proposed Solution

When a lift has logged sets and no training max, the app asks the lifter whether to set one up. The
offer comes with a starting value estimated from the lift's own logged sets, which the lifter can
change before saving. One shared prompt row is used in four places:

1. **Settings → Training Maxes**: a standing "Lifts without a training max" section.
2. **Finishing a workout**: a dialog before leaving the logger, when the workout logged a lift that
   plans from a training max and has none.
3. **The import result**: lifts the import brought in without a max.
4. **Progression**: lifts that recalculation or a new macrocycle skipped for `no-training-max`.
   This place has no screen yet; see [Sequence](#sequence).

The lifter can answer **Set up**, **Not now** (ask again next time), or **Don't ask again**. The last
one only hides the prompts. The lift stays listed in settings, where the lifter can still set it up.

### Which lifts count

A lift needs a max when, in the active program, it has logged sets and no training max. On the
workout trigger, a lift also counts only if this workout planned it from a training max. That covers
every program row, and a slot whose progression type isn't `manual` once
[#1206](https://github.com/merickvaughn/lifting-logbook/issues/1206) ships. A lift with no spec row
counts too. After [#1211](https://github.com/merickvaughn/lifting-logbook/issues/1211), it
progresses by its resolved type once it has a max.

### The estimate

- **Source.** The lift's sets logged in the 8 weeks up to its most recent logged set.
- **Calculation.** The set with the highest estimated 1RM, using `estimateOneRepMax` (Brzycki, the
  formula onboarding uses). The training max is 90% of that estimate.
- **Rounding.** The same calculation as onboarding's "Estimate from a recent lift"
  (`OnboardingFlow.tsx`): `floorToIncrement(estimateOneRepMax(weight, reps) * 0.9)`, with the
  default increment `ESTIMATE_FLOOR_INCREMENT`. It floors, per
  [`docs/standards/training-max-precision.md`](../standards/training-max-precision.md) (a
  formula-derived estimate floors), so 100 × 5 gives 100.
- **Exclusions.** Sets with zero weight or more than `MAX_ESTIMATE_REPS` reps don't count.
- **No usable set.** The input starts empty, and the lifter types a value.

The prompt always shows where the estimate came from, for example "From 100 kg × 5 on 3 Nov". It
never saves without the lifter's click.

Setting up the max writes it through the existing `PATCH /programs/:program/training-maxes`, which
already accepts a lift that has no max. A history entry is recorded the way a settings edit records
one. The skipped sets don't then move the new max: the estimate already reflects them. Later sets
progress it normally.

### Data

- **`GET /programs/:program/training-maxes/missing`** lists each such lift with:
  - `lift`, `lastLoggedDate` and `setCount`;
  - `estimate` (`{ weight, unit, from: { date, weight, reps } } | null`);
  - `dismissed`.
  - An optional `lifts` query parameter narrows the list to the lifts a finished workout logged.
- **A dismissal table**, one row per user, program and lift, with forced row-level security like
  the other per-user tables:
  - `PUT /programs/:program/training-maxes/missing/:liftId/dismissal` sets "Don't ask again". The
    path and the stored row use the lift's stable id
    ([#1139](https://github.com/merickvaughn/lifting-logbook/issues/1139)), not its display name;
  - `DELETE` on the same path clears it ("Ask again").

### Screens

**Settings → Training Maxes.** A new section above the existing table. It shows only when the list
is non-empty.

```
Lifts without a training max
These lifts have logged sets but no training max, so progression skips them.

  Romanian Deadlift   12 sets, last on 3 Nov   [ 100  ] kg   [Set up]  [Don't ask again]
                      Estimated from 100 kg × 5 on 3 Nov
  Farmer's Carry      4 sets, last on 28 Oct   [      ] kg   [Set up]  [Don't ask again]
                      No set to estimate from: enter a training max

  ▸ Hidden from prompts (1)
      Cable Curl      [Set up]  [Ask again]
```

**Finishing a workout.** After **Finish workout**, a modal dialog appears before navigating when the
workout logged at least one lift that counts and isn't dismissed. The estimate here uses the sets
just logged, along with the rest of the 8-week window. **Not now** on the dialog's footer applies
to every row left unanswered. Closing the dialog does the same.

```
┌ New lifts need a training max ─────────────────────────────┐
│ Workouts plan these lifts from a training max, and they     │
│ don't have one yet. Until they do, they plan at 0 and don't │
│ progress.                                                   │
│                                                             │
│ Romanian Deadlift  [ 100  ] kg   [Set up] [Don't ask again] │
│                    Estimated from 100 kg × 5 today          │
│                                                             │
│                                  [Not now]   [Set up all]   │
└─────────────────────────────────────────────────────────────┘
```

**The import result.** A "Lifts without a training max" block under the commit summary, with the
same rows as settings, listing the lifts this import brought in that count.

**Progression.** The start-macrocycle or recalculation screen lists every `skipped` entry. Those with
reason `no-training-max` get the same row. Other reasons, such as #1211's "no reps resolved", show a
plain explanation with no Set up action.

### Failure handling

- **The workout dialog.** If the missing-maxes fetch fails, the dialog doesn't show, the logger
  navigates as it does today, and the error goes through `logClientError`. Finishing a workout must
  never be blocked. Test coverage follows
  [`docs/standards/error-fallback-test-coverage.md`](../standards/error-fallback-test-coverage.md).
- **Settings and the import result.** The section is omitted on a failed fetch, and the failure is
  logged.
- **A failed save.** The row keeps its value and shows the error inline.

### Accessibility

- The dialog is a native `<dialog>` opened modally. Focus starts on the first weight input. Every
  way of closing it (**Set up all**, **Not now**, Esc) navigates to the dashboard, so focus moves
  with the navigation.
- Each weight input is labelled with its lift, and each estimate line is tied to its input with
  `aria-describedby`.
- Buttons carry visible text, with no icon-only controls.

## Acceptance Criteria

- [ ] The API lists lifts that have logged sets and no training max, each with an estimate. Check:
  an API e2e test logs Romanian Deadlift (no max) at 100 × 5 and Squat (with a max). It asserts
  `GET /programs/:program/training-maxes/missing` returns only Romanian Deadlift, with `estimate.weight`
  equal to `floorToIncrement(0.9 × estimateOneRepMax(100, 5))` and `from` naming that set.
- [ ] The estimate uses only sets within 8 weeks of the lift's latest set, and none when no set is
  usable. Check: core tests assert that an older heavier set is ignored, and that a lift with only
  zero-weight sets returns `null`.
- [ ] "Don't ask again" is stored per user, program and lift, and can be cleared. Check: an API e2e
  test PUTs and then DELETEs the dismissal and asserts `dismissed` flips. `rls.db.e2e.spec.ts`
  asserts another user can't read the row under the restricted role.
- [ ] Settings → Training Maxes offers setup and lists dismissed lifts. Check: a page test asserts the
  section renders a prefilled input, that **Set up** sends `PATCH …/training-maxes` with that lift,
  and that a dismissed lift shows under "Hidden from prompts" with **Ask again**. A second test with
  an empty list asserts the section is absent.
- [ ] Finishing a workout asks only when needed and never blocks. Check: logger tests assert:
  - the dialog opens when the workout logged a lift with no max;
  - it doesn't open for a dismissed lift, or for a workout whose lifts all have maxes, and the
    logger navigates at once;
  - a failed fetch navigates and calls `logClientError`.
- [ ] The import result lists imported lifts without a max. Check: an `ImportWizard.test.tsx` case
  commits history for a lift with no max and asserts the row and its estimate render.
- [ ] Progression's skipped lifts can be set up once that screen exists. Check: a component test
  renders the shared prompt from a `skipped` list. It asserts a `no-training-max` entry gets a
  **Set up** row and another reason gets none.
- [ ] Copy says "lift", not "exercise". Check: the Playwright run
  (`npm run test:e2e -w @lifting-logbook/web`) passes, and a test asserts the section heading text.

## Out of Scope

- **The start-macrocycle and recalculation screens themselves.** Domain-model D9 tracks them. This
  proposal defines the prompt they reuse.
- **Changing how a lift progresses after it has a max.** That's
  [#1206](https://github.com/merickvaughn/lifting-logbook/issues/1206).
- **Own maxes for lift modifications.** [#1153](https://github.com/merickvaughn/lifting-logbook/issues/1153)
  covers those; this proposal covers only a lift's own training max.
- **Asking on the lift detail page.** Not chosen. It keeps its "No training max set." line.
- **Running a test week or onboarding's other discovery methods from the prompt.** The prompt
  offers the estimate and a typed value only.

## Sequence

The first three places can ship now. The progression place lands with the start-macrocycle screen
(D9), using the shared row. The workout trigger depends on knowing which lifts the workout planned
from a training max. That's every planned lift today, and it narrows to non-`manual` types after
#1211.

## Open Questions

- Is 8 weeks the right estimate window, or should it follow the macrocycle the lift was last trained
  in, once [#1170](https://github.com/merickvaughn/lifting-logbook/issues/1170) assigns imported
  history to macrocycles?
- Should [#1103](https://github.com/merickvaughn/lifting-logbook/issues/1103) (a Manage Lifts
  replacement with no max) close against #1150 plus this proposal? Its throw is gone, and this
  covers its "create a starting max" option.

## References

- [#1150](https://github.com/merickvaughn/lifting-logbook/issues/1150): progression skips and
  reports a lift with no max or spec row.
- [Progression Type per Lift](2026-11-10-lift-progression-types.md), section "Lifts with no spec row".
- [`docs/standards/training-max-precision.md`](../standards/training-max-precision.md).
- [`docs/standards/error-fallback-test-coverage.md`](../standards/error-fallback-test-coverage.md).
- [`docs/domain-model.md`](../domain-model.md), D9.
- Brzycki, M. (1993). "Strength Testing—Predicting a One-Rep Max from Reps-to-Fatigue." *Journal of
  Physical Education, Recreation & Dance*, 64(1), 88–90.
  [doi:10.1080/07303084.1993.10606684](https://doi.org/10.1080/07303084.1993.10606684)
- [MDN: `<dialog>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog) and
  [WAI-ARIA Authoring Practices: Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
