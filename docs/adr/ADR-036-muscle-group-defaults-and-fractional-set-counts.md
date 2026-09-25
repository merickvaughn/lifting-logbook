# ADR-036: Muscle-Group Defaults Live in the Catalog, and Weekly Sets Count Fractionally

**Status:** Accepted
**Date:** 2026-09-25
**Issue:** [#1013](https://github.com/merickvaughn/lifting-logbook/issues/1013) (sub-issue [#1016](https://github.com/merickvaughn/lifting-logbook/issues/1016))
**Proposal:** [`docs/proposals/2026-09-25-weekly-sets-per-muscle-group.md`](../proposals/2026-09-25-weekly-sets-per-muscle-group.md)
**Related:** [ADR-002](ADR-002-ports-and-adapters.md) (ports and adapters), [ADR-035](ADR-035-client-side-rest-timer-state.md) (the rest timer reads lift classification)

---

## Context

#1013 asks for **weekly working sets per muscle group**, and per movement pattern, in three places:
- the program views;
- the Cycle Program page;
- the dashboard's current week.

Lifters use these counts to judge a program's balance, and hypertrophy dose-response research
measures volume in the same units. The app holds every input: the spec, the week's workouts, skips
and swaps, and the logged sets. What it lacked was data it could count against.

- **Muscles.** The only muscle data was `LiftMetadata.muscleGroups`: optional, per-user free text,
  keyed by lift name, with no vocabulary and no defaults (`docs/domain-model.md` §2, whose section
  was titled "A fifth axis that never joins" before this change). A fresh user would have seen
  every set as unassigned.
- **Names.** Six of Leangains' twelve preset lift names resolved to no catalog lift:
  `Weighted Pull-ups`, `Incline DB Press`, `Cable Row`, `Leg Curl`, `Calf Raises` and
  `Lateral Raises`. RPT uses two of the same names. Even built-in data could not reach those lifts.
- **Movement patterns.** Every catalog lift already carried combinable
  push/pull + vertical/horizontal tags, but no production code read them (divergence D8).
  Three tags also contradicted the usual coaching convention that direction is measured
  relative to the **torso**:
  - Dip was tagged horizontal push.
  - Upright Row was tagged horizontal pull.
  - Lateral Raise, a single-joint abduction, was tagged push + vertical.

The design choices below were made with the user; the proposal records the discussion.

## Decision

1. **Defaults live in code, on the catalog.** `LIFT_CATALOG` is typed as `readonly CatalogLift[]`,
   where `CatalogLift extends Lift` with `muscles: MuscleTargets` (`primary` and `secondary`). A
   missing entry is therefore a compile error, and the shared `Lift` type is unchanged.
   - Muscles come from a fixed 17-group vocabulary, `MUSCLE_GROUPS` in `packages/types`.
   - The shoulder is split into front, side and rear delts, and the back into lats, upper back,
     traps and lower back, because those regions respond to different movements.
   - Three lifts the presets use joined the catalog: Incline Dumbbell Press, Cable Row and Leg Curl.
2. **A user override replaces the defaults, per exact lift name.** A `LiftMetadata` row with either
   muscle list non-empty replaces both lists for that name. Both lists empty means "use the
   defaults", which is also the state of a lift nobody has edited. Overrides do **not** follow
   aliases: an override on "Squat" leaves "Back Squat" on its defaults.
3. **Only working sets count.**
   - A set counts **1 toward each primary** muscle and **½ toward each secondary**, the
     "fractional" method in Pelland et al. (2025).
   - Warm-ups never enter planned volume: a spec's `sets` counts work sets only.
   - A muscle listed as both primary and secondary counts as primary.
4. **Movement patterns follow the torso-relative rule.**
   - Pattern rows (Horizontal/Vertical Push, Horizontal/Vertical Pull, Squat, Hinge, Carry,
     Isolation / other) are derived from the existing tags. Each set counts once toward each row
     its lift earns.
   - Dip becomes a vertical push, and Upright Row a vertical pull.
   - Single-joint moves carry no direction. Raises (Lateral Raise, Calf Raise) carry no tag, and
     curls (Cable Curl, Leg Curl) keep a lone `pull`. Both count as "Isolation / other".
   - Incline pressing stays a horizontal push. A bench inclined θ° presses at (90 − θ)° to the
     torso's long axis, so an incline of 45° or less presses at least as close to perpendicular as
     to parallel. What the incline mainly changes is regional chest emphasis, a muscle question
     rather than a pattern one.
5. **Preset names resolve through per-entry catalog `aliases`, not `DEFAULT_SLOT_MAP`.**
   `builtInLiftFor` recognizes every name a built-in goes by, and backs classification, muscle
   defaults and patterns alike:
   - catalog name;
   - catalog id;
   - per-entry alias;
   - slot name.
6. **A name shared by a built-in and a custom lift resolves by one rule** (`lookupLift`).
   - A **reserved** name, meaning a `DEFAULT_SLOT_MAP` slot name that the custom-lift guard
     already refuses, always means the built-in.
   - **Any other name** prefers the user's custom lift with that exact name or uuid, because its
     classification and patterns are what the user recorded. This covers catalog display names,
     aliases and the new catalog names, all of which the guard allows and import creates.
   - Default muscles are the exception. They attach to the *name*: a same-named custom lift has no
     muscle data of its own, so it reads the built-in's defaults until the user overrides them.
7. **Counting is pure core code.**
   - `weeklySetCounts` in `packages/core/src/services/volume` is one generic counter. The muscle
     and pattern breakdowns are thin wrappers around it.
   - `toVolumeTable` aligns several breakdowns into one table, so no view re-implements the row
     order or the key join. Examples are per-week columns, or Planned | Done.
   - Pages call these functions from `apps/web`, the same way `buildWorkoutDays` and
     `programLengths` are shared today. The resolver is a closure and can't cross the React
     server → client boundary, so pages pass the serializable inputs (override rows, custom
     lifts) and build it where it is used.
   - The API supplies data, not summaries: a bulk override read, a secondary-muscle column, and
     the dashboard's overrides and logged counts (#1017, #1019).

## Alternatives Considered

### Option 1: Seed per-user `LiftMetadata` rows with the defaults

Rejected. Every new user, and every lift added to the catalog, would need a write before its
counts meant anything. A better default could never reach an existing user without a data
migration. The catalog is already the source of truth for the other four lift axes.

### Option 2: Count every listed muscle as a full set

Rejected by the user. Flat credit counts a bench set as a full triceps and front-delt set, which
inflates the helper muscles on every compound lift. Keeping only the main movers instead would
hide real indirect work.

### Option 3: Count direct sets only (secondary = 0)

Rejected. It makes a heavy-pressing program look like it gives the triceps no work. Pelland et
al. compare direct, fractional (0.5) and total (1) counting. Fractional counting keeps indirect
work visible without letting it dominate.

### Option 4: Add the preset names to `DEFAULT_SLOT_MAP`

Rejected for this feature. `DEFAULT_SLOT_MAP` has three other jobs:
- it drives the logger's bodyweight detection (`workout/[workoutNum]/page.tsx`);
- it validates imports;
- it guards custom-lift names against collisions.

Aliasing `Weighted Pull-ups` → `pull-up` there would make it a bodyweight-component lift and change
how it logs. Each consumer is its own product decision, tracked in
[#1015](https://github.com/merickvaughn/lifting-logbook/issues/1015).

### Option 5: Server-computed summary endpoints

Rejected. The three views need three differently shaped summaries: per block week, a live editor
draft, and planned vs. done. The counting has to be shared regardless, so pure core functions called
wherever the data already is avoid three new endpoints.

### Option 6: Let an override follow the lift's aliases

Rejected. If an override on "Squat" also applied to "Back Squat", two rows could claim one lift. The
lift editor's "reset to defaults" could then not say which row it resets. Every other `LiftMetadata`
field is exact-name too.

### Option 7: An "incline" direction, or an upper/lower chest split

Declined. An incline of 45° or less presses at least as close to perpendicular to the torso as to
parallel, so it is a horizontal push; only steeper, near-overhead angles, which the catalog doesn't
carry, would cross over. The EMG evidence (Rodríguez-Ridao et al. 2020) is about *which part of
the chest* works: upper-pec activity peaks around 30°, and above 45° the front delt takes over. That
is a muscle-granularity question, left for a future vocabulary change if it proves needed.

### Option 8: Let the built-in win every name collision, or reserve every built-in name

The first is the rule `liftClassificationFor` had before this change. It was justified only for
`DEFAULT_SLOT_MAP` keys, which are shared template vocabulary, yet it also silently overrode
custom lifts that users were allowed to create. Before this ADR, the import wizard's custom
"Cable Row" or "Leg Curl" was the only way a Leangains user could get those lifts classified.
Rejected.

Reserving every built-in name in the create/rename guard would prevent the collision instead.
It needs an audit of the custom lifts users already have, so it is left to #1015.

## Consequences

### Positive

- **Counts work immediately.** A fresh user sees meaningful counts on every built-in program.
  Every `PRESET_BASE_SPECS` lift resolves to a catalog lift with defaults, and a test enforces it.
- **The movement tags are finally read.** This partly resolves D8.
- **Timer rests match the lift.** The six formerly unresolved preset names now classify, so the rest
  timer applies the user's opt-in accessory durations to Leangains' and RPT's accessories. Before,
  it silently fell through to the preset.

### Negative / Risks

- **The timer changes behavior.** The classification fix above is visible to anyone who had enabled
  accessory durations.
- **Legacy lists are read as primary.** A `LiftMetadata` row written before secondary muscles
  existed has one flat list, so seeded or hand-entered helper muscles get full credit until the user
  edits the lift.
- **Done counts every logged row.** Set kind isn't stored (domain-model §4), so an imported warm-up
  counts. The logger itself records only working sets.
- **Pre-existing defects still apply:**
  - D3: renaming a custom lift orphans its `LiftMetadata`, including muscle overrides.
  - D2: lift overrides survive delete-then-initialize, which the current-week counts (#1019) will
    inherit.
- **Legacy encoded rows.** Override rows written by the lift editor before #1017 carry a
  URL-encoded name (`Bench%20Press`).
  - The resolver keys every row by its stored name. It also files a row with the bug's exact
    signature (a `%` and no whitespace) under its decoded name, but only where no row already
    holds that name, so a real name like "Squat %40 RPE" is never re-keyed.
  - #1017 fixes the write path. Its editor must fill from this resolver over all rows, or a save
    would write empty lists under the real name and hide a legacy row's tags.
- **A same-named custom lift now wins classification and patterns.** Previously the built-in won
  every collision. The only consumer that changes is the rest timer: a user's custom "Face Pull"
  or "Cable Row" is now timed by the classification they gave it. The create/rename guard still
  reserves only slot names; whether to reserve more is #1015's decision.
- **Custom lifts under their own names start uncounted for muscles** until the user tags them.
  They are counted by pattern from their own tags.

## Verification

- `packages/core/tests/core/catalog/builtInLift.test.ts`:
  - every name form resolves;
  - aliases resolve to their own entry and stay out of `DEFAULT_SLOT_MAP`;
  - every preset lift resolves with defaults, and the test asserts the extracted list is
    non-empty.
- `packages/core/tests/core/catalog/muscles.test.ts`:
  - vocabulary-only defaults with no overlap;
  - resolver precedence and exact-name matching;
  - canonical dedupe;
  - legacy encoded rows: a real-name row beats its twin; real names containing `%` are never
    re-keyed; the malformed-escape fallback;
  - a custom lift's uuid maps to its name for override lookup.
- `packages/core/tests/core/catalog/patterns.test.ts` and `classify.test.ts`:
  - the torso-rule classifications and ambiguous tags;
  - the Option 8 precedence: reserved "Squat" goes to the built-in, while custom "Cable Row",
    "Calf Raises" and "Face Pull" keep their recorded attributes;
  - custom lifts are matched by uuid.
- `packages/core/tests/core/services/volume.test.ts`:
  - the proposal's Leangains worked examples for muscles and patterns;
  - no preset lift is uncounted, and the preset list is asserted non-empty;
  - 5-3-1's three weeks collapse to one column;
  - a zeroed week stays its own column;
  - `toVolumeTable`'s row alignment and ordering;
  - ordering does not depend on locale.

## References

- Pelland, J. C., Remmert, J. F., Robinson, Z. P., Hinson, S. R., Zourdos, M. C. "The Resistance
  Training Dose Response: Meta-Regressions Exploring the Effects of Weekly Volume and Frequency on
  Muscle Hypertrophy and Strength Gains." *Sports Medicine* (2025).
  [doi:10.1007/s40279-025-02344-w](https://link.springer.com/article/10.1007/s40279-025-02344-w).
  Defines direct / fractional (indirect = 0.5) / total set counting.
- Rodríguez-Ridao, D. et al. "Effect of Five Bench Inclinations on the Electromyographic Activity of
  the Pectoralis Major, Anterior Deltoid, and Triceps Brachii during the Bench Press Exercise."
  *IJERPH* 17(19):7339 (2020).
  [doi:10.3390/ijerph17197339](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7579505/).
- r/bodyweightfitness, [Recommended Routine](https://redditbwf.github.io/wiki/recommended_routine.html).
  It pairs dips with pull-ups and push-ups with rows. This is community convention, not research;
  cited for the torso-relative classification of the dip.
- [`docs/domain-model.md`](../domain-model.md): §2 (the lift taxonomy; D8) and §4 (prescribed vs.
  logged).
- [ADR-002](ADR-002-ports-and-adapters.md): the infrastructure-free `packages/core` boundary the
  counters sit behind.
