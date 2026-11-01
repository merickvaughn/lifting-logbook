# Proposal: Initial Training Max Discovery

**Status:** `shipped`
**Date:** 2026-04-30
**Issue:** [#129](https://github.com/merickvaughn/lifting-logbook/issues/129)

---

## Problem

Training maxes are the single input that drives every working set weight calculation in the
app. `updateMaxes` throws an error if a max for any configured lift is missing, which means a
user cannot start their first cycle without maxes already in the system. The training max
management screen (shipped, #108) addresses users who already know their 1RMs, but two other
onboarding paths have no data model support:

**Estimation (mechanism 2):** The user does not know their exact 1RM but has recent performance
data — e.g., "I did 225 lbs for 5 reps last month." A standard rep-max formula (Brzycki) can
back-calculate a training max from any (weight, reps) pair. The system has no utility for this,
and the training max management screen has no input for it.

**Test week (mechanism 3):** The user has no reliable data and needs to determine their maxes
by actually lifting. This requires a structured "test week" — a special cycle phase with a
ramp-up protocol (ascending sets culminating in a heavy set of 1–3 reps) — so the system can
generate weights, accept logged results, and derive the training max. Currently, `CycleDashboard`,
`LiftingProgramSpec`, and `generateLiftPlan` have no concept of a week type or phase; a test
week is indistinguishable from a regular training week at the data and API layer.

## Proposed Solution

Three coordinated changes:

**1. `WeekType` — a new shared type**

Add `WeekType` (`'training' | 'test' | 'deload'`) to `packages/types/src/domain.ts`. Add an
optional `weekType?: WeekType` per-row field to `LiftingProgramSpec` (default: `'training'`).
The week-level declared type is derived at request time via
`weekTypeForDate(cycleDate, programSpec)` and exposed on the
`CycleDashboardResponse` as `currentWeekType` (not a per-exercise aggregate).
Originally proposed as a stored `CycleDashboard.currentWeekType` field; that
placeholder was removed in [#361](https://github.com/merickvaughn/lifting-logbook/issues/361)
because the value is never authoritative — it is always re-derived from the program
spec and date. The Sheets parser reads an optional `Week Type` column
per-row; blank rows inherit the first non-blank value in the same week, defaulting to
`'training'` if the entire week is blank. Simple programs use a uniform week type; advanced
programs may override per exercise.

**2. `estimateTrainingMax` — a new core utility**

Add `estimateTrainingMax(weight: number, reps: number): number` to `packages/core` using the
Brzycki formula: `1RM = weight / (1.0278 − 0.0278 × reps)`. Result rounds to the nearest 5
lbs. Exported from the package's public API and surfaced in the training max management screen
as an optional "estimate from reps" input.

**3. Week-type behavior**

`generateLiftPlan` and `updateMaxes` branch on `weekType`:

- **`'training'` (default):** Existing behavior — working sets at prescribed percentages,
  progression gate `reps >= spec.reps`.

- **`'test'`:** `generateLiftPlan` produces a 5-set ascending ramp-up ending in a heavy set
  of 1–3 reps (50% × 5, 65% × 3, 80% × 2, 90% × 1, 100% × 1). `updateMaxes` replaces the
  `reps >= spec.reps` gate with: any final set with non-zero logged reps, unless set notes
  flag abnormal conditions (injury, unusual stimulus) — in that case, fall back to the last
  unaffected set, or skip the update if all sets were affected. The completed set's weight
  becomes the new training max; no increment is applied.

- **`'deload'`:** `generateLiftPlan` produces a 3-set light protocol (40% × 5, 50% × 5,
  60% × 5). `updateMaxes` skips entirely — deload weeks do not count toward progression.

`GET /programs/:program/cycle-dashboard` response includes `currentWeekType`, which reflects
the week-level declared type — not a per-exercise aggregate. Per-exercise `weekType` is
consumed directly by `generateLiftPlan` and `updateMaxes` from `LiftingProgramSpec` rows.

The `weekType` field will additionally govern rest interval configuration when the timer
feature is implemented (deferred).

## Acceptance Criteria

- [ ] `WeekType` (`'training' | 'test' | 'deload'`) exported from `packages/types/src/domain.ts`
- [ ] `LiftingProgramSpec.weekType?: WeekType` added (per-row field); default is `'training'`
- [ ] Sheets parser reads optional `Week Type` column; per-row with week-level inheritance:
      blank rows inherit the first non-blank value in the same week; all-blank week defaults
      to `'training'`; simple programs use a uniform week type; advanced programs may override
      per exercise
- [ ] `weekTypeForDate(cycleDate, programSpec)` derives the week-level declared type
      (first non-blank `weekType` value in the active week's spec rows) at request time;
      not a per-exercise aggregate, not stored on `CycleDashboard`
- [ ] `estimateTrainingMax(weight, reps): number` in `packages/core` using Brzycki formula,
      rounded to nearest 5 lbs; valid rep range enforced (1–36); exported from package
      public API
- [ ] `generateLiftPlan` handles `weekType === 'test'`: 5-set ascending ramp-up to ~100% TM × 1–3
- [ ] `generateLiftPlan` handles `weekType === 'deload'`: 3-set protocol at 40% × 5, 50% × 5,
      60% × 5
- [ ] `updateMaxes` for test weeks: final set with non-zero logged reps → new TM (no
      increment); set notes flagging abnormal conditions (injury, unusual stimulus) cause
      fallback to the last unaffected set, or skip update if all sets were affected
- [ ] `updateMaxes` for deload weeks: skip entirely — no progression
- [ ] `GET /programs/:program/cycle-dashboard` response includes `currentWeekType`
- [ ] Unit tests in `packages/core` cover `estimateTrainingMax` and all three `weekType`
      branches of `generateLiftPlan` and `updateMaxes`

## Out of Scope

- Importing historical data from external sources (separate proposal)
- Rest interval configuration per week type (deferred to timer feature; `weekType` will
  govern rest protocol when the timer is implemented)
- React Native (`apps/mobile`) client for test-week and deload-week UX
- Mechanism (1): covered by #108 (shipped)

## References

- [`packages/types/src/domain.ts`](../../packages/types/src/domain.ts) — where `WeekType` enum belongs
- [`packages/core/src/models/LiftingProgramSpec.ts`](../../packages/core/src/models/LiftingProgramSpec.ts) — model to extend with `weekType`
- [`packages/core/src/presets/programLengths.ts`](../../packages/core/src/presets/programLengths.ts) — `weekTypeForDate` derives `currentWeekType` at request time (moved from `utils/jsUtil.ts`, and given the program's workout dates, in #1028)
- [`packages/core/src/services/maxes/updateMaxes.ts`](../../packages/core/src/services/maxes/updateMaxes.ts) — progression gate to relax for test weeks
- [`packages/core/src/services/workout/generateLiftPlan.ts`](../../packages/core/src/services/workout/generateLiftPlan.ts) — ramp-up protocol generation basis
- PRD §Non-Goals — "Deload / missed-session recovery" originally deferred; deload is now in scope as a distinct week type with defined progression behavior
- Brzycki, M. (1993). "Strength Testing—Predicting a One-Rep Max from Reps-to-Fatigue." *JOPERD* 64(1):88–90.
