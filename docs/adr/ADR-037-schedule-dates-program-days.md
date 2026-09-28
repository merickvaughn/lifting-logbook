# ADR-037: A Schedule Dates the Program's Workouts; It Never Numbers Them

**Status:** Accepted
**Date:** 2026-09-28
**Issue:** [#1023](https://github.com/merickvaughn/lifting-logbook/issues/1023) (found while fixing [#1014](https://github.com/merickvaughn/lifting-logbook/issues/1014), [PR #1025](https://github.com/merickvaughn/lifting-logbook/pull/1025))
**Related:** [`docs/design/workout-scheduling-integration.md`](../design/workout-scheduling-integration.md) (the scheduling design), [`docs/domain-model.md`](../domain-model.md) §3 (the workout is derived, not stored)

---

## Context

A cycle's workouts are numbered `1..N`, and every per-workout record is keyed by that number:
lift records, date overrides, skips, lift overrides and scheduled dates. Two numberings
existed.

- **The program's.** Workout N is the program's N-th `(week, offset)` day, taken from its spec
  tiled to the canonical length (`orderedWorkoutKeys(expandSpecToLength(…))`). These used it:
  - the Cycle Dashboard grid (`buildWorkoutDays`), for its cards and their prescriptions;
  - no-schedule mode;
  - the skip and reschedule bounds checks;
  - the workout endpoint, for the day's offset.
- **The schedule's.** `saveScheduledDates` created `numWeeks × getScheduleWorkoutsPerWeek(schedule)`
  scheduled workouts. It numbered them in order through the calendar weeks `distributeWorkouts`
  filled, and stored each one's calendar week as `weekNum`. The workout endpoint treated that
  `weekNum` as the program week, and the cycle dashboard response grouped `weeks` by it. The plan
  page reads those weeks as program weeks.

The two agree only when every calendar week of the schedule trains exactly the program's number
of days. Nothing enforced that. A code comment promised a "Phase 5" confirmation prompt that was
never built, and there is no onboarding schedule step: a schedule is set in Settings and applied
when a cycle is created.

The most common setup drifted: the default program, 5-3-1, trains two days a week, and the default
schedule is Mon/Wed/Fri.
- It scheduled 36 workouts for 24 program days. Workouts 25–36 had no program day and planned
  nothing.
- Workout 3, the first Friday, is program week 2's first day on its Dashboard card. The detail
  page showed week 1, whose 5s prescription differs from week 2's 3s.
- A rotating schedule drifted every week it differed from the program.
- A schedule with fewer days a week than the program scheduled too few workouts. The unscheduled
  tail fell back to spec-relative dates, out of calendar order.
- In an imported spec whose weeks train different offsets, the stored week and the derived offset
  could together name a day that week doesn't train, which gave an empty workout.

## Decision

**Map explicitly, by the program's own numbering.** Workout N of a cycle is always the program's
N-th `(week, offset)` day, in both modes. `programWorkoutKeys(program, spec)` in
`packages/core/src/presets/programLengths.ts` is that numbering, and the only way to get it: the
underlying `orderedWorkoutKeys` is module-private, because numbering an untiled block with it was
the #740 bug. A schedule only dates the days.

1. **Generation.** `saveScheduledDates` schedules exactly the program's days:
   - `distributeWorkouts(days.length, schedule, cycleDate)` yields one date per day, and scheduled
     workout N gets the N-th date;
   - its `weekNum` is day N's program week.

   A schedule training more or fewer days a week than the program, or a different number each
   week, stretches or compresses the calendar. It no longer renumbers the program. If
   `distributeWorkouts` ever broke its contract and dated the wrong number of workouts, the cycle
   would start unscheduled with a structured error log rather than fail: numbering no longer
   depends on the schedule, so only the dates would be lost.
2. **Reads.** Readers take the week and day from `workoutNum`, and only the date from the row. All
   three read `programWorkoutKeys`:
   - The workout endpoint, through `workoutKeyForWorkoutNum`. The one exception is a row past
     the program's last day, which has no program day: if it is opened directly, it is labelled
     with its own stored week and plans nothing.
   - The cycle dashboard response. With a schedule, `buildCycleDashboardResponse` lists every
     program day under its program week. Each day is dated by its override, else its row, else
     the spec-relative date the grid and endpoint also give it. Rows past the last day are left
     out, with one structured warning per load. It numbers the days itself from the spec it is
     given, so a caller can't hand it a different numbering.
   - The web grid (`buildWorkoutDays`).
3. **Order.** `distributeWorkouts` emits each week's days in weekday order. The settings validator
   accepts days in any order, and workout order must match date order.
4. **No validation.** Any valid schedule works with any program, and the schedule sets the pace.
   This is the scheduling design's own premise: "the pace (workouts per week) is an emergent
   property of the schedule."
5. **Plan page.** The Program Plan's estimated completion is the latest date among the cycle's
   workouts, in both modes (`estimateCompletionDate`). Each workout is dated with the Cycle
   Dashboard's own precedence, `workoutDateResolver`: override, then scheduled date, then
   spec-relative date. With a schedule, program weeks are no longer calendar weeks, and a
   rescheduled workout moves the estimate whether or not there is a schedule.

## Alternatives Considered

### Option 1: Validate the schedule against the program at activation

This would require the schedule's days per week to equal the program's. The #1023 comment points
out that it would also need every program week to train the same offsets. Rejected:
- **One schedule serves every program.** Validating when Settings is saved would need the active
  program, and a later program switch would then have to reject or drop the schedule. Validating
  at cycle creation would either block the cycle (a Mon/Wed/Fri user couldn't start 5-3-1) or
  silently drop to no-schedule mode.
- **Rotating schedules would be unusable.** Every preset trains the same number of days each week,
  so no rotation would pass. That contradicts the scheduling design.
- **Both numberings would remain.** Any future path that writes scheduled rows could drift the
  same way, and existing cycles would stay wrong.

### Option 2: Persist each scheduled workout's `(week, offset)`

Add an `offset` column to `cycle_scheduled_workout` (with `weekNum` as the program week), and read
the pair in the endpoint and the dashboard. Rejected:
- **It stores a copy of a derivable value.** The pair is a function of the spec and `workoutNum`,
  and the stored copy disagreeing with the derived one is exactly this bug. This is Codd's
  redundancy and consistency argument.
- **It brings back a second numbering.** The grid would need a separate schedule-mode path that
  builds cards from rows instead of the spec.
- **It needs a migration and a backfill** that SQL can't compute, because the pairs come from
  tiling the spec in TypeScript.
- **Its one advantage doesn't hold.** Pinning a day across a mid-cycle spec edit doesn't help:
  lift records, skips and overrides are keyed by `workoutNum` too, and no-schedule mode would
  still renumber.

### Option 3: Fix generation only, and keep the stored `weekNum` authoritative

Rejected. Existing cycles would stay wrong until a new cycle was generated. Reading the week from
the row and the offset from the program is the combination that produced empty days.

## Consequences

### Positive

- **One numbering, in both modes.** The workout endpoint, the Dashboard grid and response, the
  plan page's phases and completion estimate, and the skip and reschedule bounds share it. They
  can't disagree on week, day or prescription.
- **Any schedule works with any program:** rotating, more days, or fewer.
- **Existing cycles read correctly without a migration**, because readers no longer trust a
  row's stored week.
- **Rollback is a code revert.** There is no schema change, and rows written under this ADR carry
  the program week, which the previous reader also treats as the program week.

### Negative / Risks

Existing cycles keep their stored dates:
- **A row past the program's last day stays in place.**
  - The dashboard leaves it out and logs one structured warning per load, so the affected cycles
    can be found in Loki.
  - If it is opened directly, the workout endpoint still serves it as a workout with no planned
    lifts, logs a warning, and keeps any sets logged against it visible.
- **A cycle scheduled with fewer days a week than the program has no rows for its last days.**
  Those days show their spec-relative dates on the card, on the detail page and in the dashboard
  response, whose program weeks are therefore complete, so the plan page's phases can still
  finish. The dates stay out of calendar order with the scheduled ones until the next cycle.

Re-dating a cycle when the schedule changes is [#1032](https://github.com/merickvaughn/lifting-logbook/issues/1032).

Three limits are not changed by this ADR:
- **A mid-cycle spec edit still renumbers the workouts**, as it always has.
- **`distributeWorkouts` aligns weeks in local time**, so on a host west of UTC a schedule can
  start a week early. That is [#1031](https://github.com/merickvaughn/lifting-logbook/issues/1031);
  production runs in UTC.
- **`weekTypeForDate` still finds the current week by counting calendar weeks** since the cycle
  start. It feeds the dashboard's `currentWeekType` and the training-max history `source`, and it
  also clamps instead of tiling. With a schedule's own pace, calendar weeks and program weeks
  differ. It is latent, because no preset tags a week type, and it is tracked with the clamping in
  [#1028](https://github.com/merickvaughn/lifting-logbook/issues/1028).

## Verification

- **`programs.e2e.spec.ts`** (HTTP, in-memory). For a rotating schedule and for Mon/Wed/Fri on
  5-3-1:
  - the dashboard lists exactly the program's 24 days;
  - `GET /workouts/25` is a 400;
  - for every scheduled workout, the endpoint's week, offset, lifts and date match the program's
    N-th day and the week the dashboard lists it under.

  Both cases fail before this change.
- **`cycle-generation.service.spec.ts`.** For a rotating schedule, more days a week and fewer
  days a week:
  - one scheduled workout per program day;
  - each one's `weekNum` is its program week;
  - the dates walk the schedule in order.

  With a mocked `distributeWorkouts` that breaks its contract, the cycle starts unscheduled and
  an error is logged.
- **`workouts.controller.spec.ts`.** A row saved before this change with a calendar week gets its
  program week and day.
- **`cycle-dashboard.controller.spec.ts` and `mappers.spec.ts`.**
  - Every program day is listed by program week.
  - A day with no row gets its spec-relative date.
  - A row past the last day is left out, with one warning.
- **`programLengths.test.ts`.** For every preset, `programWorkoutKeys` numbers each day of the
  tiled program once, in order. The expected days are derived independently of the
  implementation.
- **`distributeWorkouts.test.ts`.** Days listed out of order are dated in weekday order.
- **`programPlan.test.ts` and `workoutPlan.test.ts`.**
  - `estimateCompletionDate` gives the same answer with and without a schedule that dates the
    days alike, and counts overrides in both modes.
  - `workoutDateResolver` follows its precedence.

## References

- E. F. Codd, "A Relational Model of Data for Large Shared Data Banks," *Communications of the
  ACM* 13(6):377–387 (1970), [doi:10.1145/362384.362685](https://doi.org/10.1145/362384.362685).
  Section 2 defines redundancy (data derivable from other data) and the consistency problems it
  causes. Option 2 would add exactly that: a stored `(week, offset)` derivable from the spec.
- [`docs/design/workout-scheduling-integration.md`](../design/workout-scheduling-integration.md):
  the schedule mode this implements, where the program provides the workout sequence and the
  schedule the days.
- [`docs/domain-model.md`](../domain-model.md) §3: `workoutNum` is a global ordinal from the
  program's ordered workout days, and the workout itself is derived.
