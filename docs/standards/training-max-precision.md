# Coding Standard: Training-Max Weight Precision

**Applies to:** all packages and apps — anywhere a training-max or 1RM weight value is parsed, persisted, compared, or derived
**Status:** Active
**Related issue:** [#633 — Training-max precision loss and configurable workout-rounding increment](https://github.com/merickvaughn/lifting-logbook/issues/633)

---

## Rule

Training-max weight is a `Float` (`apps/api/prisma/schema.prisma`) because users' plate
increments (commonly 2.5 and 1.25 lbs) produce values with up to 2 decimal places, e.g.
`316.25`. Whether a code path may round that value — and how — depends entirely on where
the value *comes from*:

1. **Directly-known values** — a value the user typed, imported from a file, or that is
   already stored — **must be persisted, compared, and displayed at full precision**. Do
   not call `Math.round()`, `toFixed(0)`, or similar on these. If a comparison needs
   tolerance for floating-point noise from upstream arithmetic, round to **2 decimal
   places**, never coarser — 1 decimal place is not sufficient (see Why, below).
2. **Formula-derived estimates** — a 1RM estimated from a weight×reps set (Brzycki
   formula), or a training max derived from that estimate at a fixed percentage — are
   approximations by nature, and this repo's convention is to **floor down to the nearest
   plate increment** (`floorToIncrement()` in `packages/core/src/constants/config.ts`,
   default 2.5 lbs) rather than round to nearest. Floor, not round: a lifter should never
   be told to load slightly more than their estimate supports.
3. **Computed per-workout target weights** — a percentage of a training max, generated
   while planning a specific set (e.g. "70% of your squat TM this week") — must round to
   the nearest *loadable* plate combination. This is the one case where rounding to a
   coarser value than the stored training max is not just acceptable but required — you
   cannot load a bar to a non-plate weight. Use `MROUND()` (`packages/core/src/constants/config.ts`),
   which rounds to the program spec's configured `increment` field, not a hardcoded value.

When adding a new code path that touches a training-max or 1RM weight, identify which of
these three categories it falls into before deciding whether — and how — to round.

---

## Why

[PR #636](https://github.com/merickvaughn/lifting-logbook/pull/636) fixed four places where a
directly-known value (category 1) was silently rounded to a whole number, contradicting
that code's own documented "persisted as-is" contract in three of the four cases. Git blame
traced one of them to [PR #560](https://github.com/merickvaughn/lifting-logbook/pull/560), which
introduced the "enter training maxes directly" onboarding method by copy-pasting the
adjacent estimate-derivation code's rounding pattern (category 2) without reconsidering it
for a path meant to have none. The contract existed only in a code comment — nowhere a
future contributor modifying adjacent code would necessarily see it before repeating the
mistake.

A fourth bug in the same PR was in a category-1 path with a legitimate reason for *some*
rounding tolerance (absorbing floating-point noise from upstream arithmetic in
`macrocycle-generation.service.ts`'s history-change detection) — but the tolerance was coarser
(1 decimal place) than the precision that actually matters to users, silently dropping real
sub-0.1lb changes from history. This is why the rule above specifies a floor on how coarse
a *comparison* tolerance may be, separately from the "no rounding at all" rule for the
persisted/displayed value itself.

---

## Examples

### Good: full precision through the import pipeline

`apps/web/app/(authed)/import/ImportWizard.tsx`'s `buildTrainingMaxesCsv()` rebuilds a CSV
from user-edited rows for the commit API — `${Number(r.weight)}`, no rounding.

### Good: floor-to-increment for an estimate

`packages/core/src/services/maxes/estimateOneRepMax.ts`'s `estimateOneRepMax()` estimates a
1RM from a weight×reps set and floors the result: `floorToIncrement((weight * 36) / denom)`.

### Good: increment-aware rounding for a computed workout weight

`packages/core/src/services/workout/calculateLiftWeights.ts` calls
`MROUND(currLiftTm * pct, currLiftIncrement)` — rounds to the program's configured plate
increment, not a hardcoded value, and never touches the stored `TrainingMax.weight`.

### Bad: rounding a directly-entered value

```ts
// apps/web/app/(authed)/onboarding/OnboardingFlow.tsx (pre-#636)
if (valuesAreTrainingMax(method)) {
  return { lift: row.lift, oneRm: null, trainingMax: Math.round(w) };
}
```

`w` here is a value the user typed directly (`tm` method) or imported from a CSV (`import`
method) — both categorized by this file's own `valuesAreTrainingMax()` docstring as
"persisted as-is... no adjustment." Rounding it violates that contract silently.

---

## Enforcement

No automated static check exists for this standard — unlike `fetch-cache-semantics.md` and
`error-fallback-test-coverage.md`, a lint rule would need to distinguish "this `Math.round()`
call operates on a training-max-shaped value" from any other numeric rounding in the
codebase, which isn't reliably inferable from syntax alone. This standard is enforced by
code review: when a PR touches training-max weight handling, confirm which of the three
categories above applies and that the rounding behavior (or lack of it) matches.

---

## References

- [Issue #633 — Training-max precision loss and configurable workout-rounding increment](https://github.com/merickvaughn/lifting-logbook/issues/633) — the audit that produced this standard
- [PR #636 — Preserve training-max decimal precision in Import, onboarding, and history](https://github.com/merickvaughn/lifting-logbook/pull/636) — the incident and fix
- [PR #560 — Add 'enter training maxes directly' onboarding method](https://github.com/merickvaughn/lifting-logbook/pull/560) — introduced one of the four bugs fixed in #636
- [Issue #642 — Consolidate duplicate Brzycki 1RM-estimation implementations onto packages/core](https://github.com/merickvaughn/lifting-logbook/issues/642) — moved `floorToIncrement()`/the estimate formula from `apps/web` into `packages/core` so this standard's category-2 convention has a single implementation instead of two that could drift again
