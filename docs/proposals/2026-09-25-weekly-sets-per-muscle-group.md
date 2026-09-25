# Proposal: Weekly Sets per Muscle Group and Movement Pattern

**Status:** `accepted`
**Date:** 2026-09-25
**Issue:** [#1013](https://github.com/merickvaughn/lifting-logbook/issues/1013). Sub-issues: [#1016](https://github.com/merickvaughn/lifting-logbook/issues/1016), [#1017](https://github.com/merickvaughn/lifting-logbook/issues/1017), [#1018](https://github.com/merickvaughn/lifting-logbook/issues/1018), [#1019](https://github.com/merickvaughn/lifting-logbook/issues/1019).

---

## Problem

Lifters check whether a program is balanced by counting **weekly working sets per muscle group**:
"is my side-delt work anywhere near my chest work?", "did swapping rows for pulldowns cost my
upper back anything?" Hypertrophy dose-response research also measures volume in these units.
The app already holds every input needed to answer that: the program spec, the week's workouts,
skips and lift swaps, and every logged set. It still can't answer it, because it has no usable
lift→muscle mapping.

Muscle groups exist only as optional, per-user, free-text `LiftMetadata.muscleGroups` keyed by
lift name. There is no vocabulary and no defaults (`docs/domain-model.md` §2, "A fifth axis that
never joins"), so a new user would see every set as unassigned. Built-in data couldn't fill the
gap on its own either: six of Leangains' twelve preset lift names (`Weighted Pull-ups`,
`Incline DB Press`, `Cable Row`, `Leg Curl`, `Calf Raises`, `Lateral Raises`) don't resolve to
any catalog lift.

Movement balance is the other half of the same check: how much horizontal pushing versus
horizontal pulling, and how much vertical pushing versus vertical pulling, a program does each
week. The catalog already tags every lift with a movement pattern (push or pull, vertical or
horizontal, squat, hinge, carry), but nothing reads those tags (divergence D8). Three of them also
contradict the convention that direction is measured relative to the torso. Dip is tagged
horizontal push, Upright Row horizontal pull, and Lateral Raise push + vertical.

## Proposed Solution

Give every built-in lift **default primary and secondary muscle groups**, drawn from a fixed
17-group vocabulary, and let the user override them per lift. A working set counts **1 toward
each primary** muscle and **½ toward each secondary**, the "fractional" counting method.
Warm-ups never count toward planned volume.

The resulting **sets per muscle group per week** table appears in three places:

1. **The program itself.** It shows in the Details panel of each built-in program with a real
   spec (Leangains, RPT). The My Programs editor shows it too, recomputed live as days are edited.
2. **The program in use.** It shows on the Cycle Program page.
3. **The current week.** It shows in the dashboard's expanded week, with two columns:
   - **Planned**: the week's prescribed working sets, dropping skipped workouts and applying
     Manage Lifts swaps, adds and removes.
   - **Done**: the sets logged so far.

The same sets can also be viewed **by movement pattern**, with a toggle between the two views.
The pattern view has eight rows: Horizontal Push, Vertical Push, Horizontal Pull, Vertical Pull,
Squat, Hinge, Carry, and Isolation / other. Each set counts once toward each pattern its lift
has. The rows come from the existing catalog tags, and custom lifts are counted by their own
tags.

The torso-relative rule gets applied consistently in the catalog:

| Lift | Current tag | Corrected tag |
|---|---|---|
| Dip | horizontal push | vertical push |
| Upright Row | horizontal pull | vertical pull |
| Lateral Raise | push + vertical | no push/pull tag (an abduction isolation lift) |

Incline pressing stays horizontal push. A bench inclined θ° presses at (90 − θ)° to the torso, so
an incline of 45° or less presses at least as close to perpendicular as to parallel. What the
incline mainly changes is regional chest emphasis.

When every week of a program has the same counts, the table collapses to a single "sets / week"
column. Lifts with no muscle groups or pattern are listed as not counted rather than silently
dropped.

All counting lives in pure `packages/core` functions, so the web app and the API share one
implementation. The API adds three things:

- a bulk read of the user's overrides;
- a secondary-muscle column on the overrides table;
- the lift-override and logged-set-count data the dashboard needs, delivered with the dashboard
  response the way skips and date overrides already are.

## Acceptance Criteria

- [ ] **Catalog defaults**
  - [ ] Every `LIFT_CATALOG` entry carries at least one default primary muscle, plus any
    secondary muscles, all from the 17-group vocabulary: Chest · Front Delts · Side Delts ·
    Rear Delts · Triceps · Biceps · Forearms · Lats · Upper Back · Traps · Lower Back · Core ·
    Quads · Hamstrings · Glutes · Adductors · Calves.
  - [ ] The catalog gains **Incline Dumbbell Press**, **Cable Row** and **Leg Curl**.
  - [ ] Every `PRESET_BASE_SPECS` lift name resolves to a catalog lift with defaults. A test
    enforces this, including an assertion that the list of preset names it checks is non-empty.
- [ ] **Lift editor**
  - [ ] It shows a lift's effective primary and secondary muscles and where they came from
    (built-in defaults or the user's own).
  - [ ] Saving stores an override, and Reset restores the defaults.
  - [ ] A multi-word lift such as "Bench Press" is saved under its real name, not a URL-encoded one.
- [ ] **Bulk read.** `GET /lifts/metadata` returns all of the caller's overrides and no one
  else's, verified under the restricted database role.
- [ ] **Program views.** The Leangains and RPT Details panels, the My Programs editor (live) and
  the Cycle Program page each show weekly sets per muscle group.
- [ ] **Current week**
  - [ ] The dashboard shows Planned and Done per muscle group.
  - [ ] Skipping a workout lowers Planned.
  - [ ] A Manage Lifts swap updates both the workout card and the counts.
  - [ ] Logging a set raises Done.
- [ ] **Worked example.** Leangains with default muscles produces these weekly totals:

  | Muscle | Sets |
  |---|---|
  | Chest | 9 |
  | Front Delts | 7.5 |
  | Triceps | 7.5 |
  | Hamstrings | 7 |
  | Glutes | 7 |
  | Lats | 6 |
  | Side Delts | 5.5 |
  | Upper Back | 5 |
  | Calves | 4 |
  | Lower Back | 4 |
  | Quads | 3.5 |
  | Biceps | 3 |
  | Adductors | 1.5 |
  | Rear Delts | 1.5 |
  | Forearms | 0.5 |
  | Traps | 0.5 |

- [ ] **Pattern view.** The same views can switch to weekly sets per movement pattern.
  - [ ] Each set counts once toward each pattern its lift has.
  - [ ] Custom lifts are counted by their own tags.
  - [ ] Leangains produces these weekly totals:

    | Pattern | Sets |
    |---|---|
    | Horizontal Push | 6 |
    | Vertical Push | 6 |
    | Horizontal Pull | 3 |
    | Vertical Pull | 3 |
    | Squat | 3 |
    | Hinge | 4 |
    | Isolation / other | 11 |

- [ ] **Tag corrections.** The catalog tags follow the torso-relative rule:
  - [ ] Dip is a vertical push.
  - [ ] Upright Row is a vertical pull.
  - [ ] Lateral Raise has no push or pull tag.
  - [ ] Incline pressing stays a horizontal push.
- [ ] **ADR.** An ADR records the counting convention, the torso-relative pattern rule, and
  where the defaults live.

## Out of Scope

- **`DEFAULT_SLOT_MAP`.** It drives import validation, the logger's bodyweight detection and the
  custom-lift name collision guard. The preset-name aliases added here are used only for muscle
  defaults and lift classification. The wider name gap is tracked in [#1015](https://github.com/merickvaughn/lifting-logbook/issues/1015).
- **Workout-plan defects found during design:** every lift of the block week is listed on every
  day; there are no planned sets after the first block; a swapped-in lift gets no planned sets.
  Fixed in [#1014](https://github.com/merickvaughn/lifting-logbook/issues/1014).
- **Custom lifts** start with no muscle groups until the user sets them. There is no standalone
  lift-library page for editing muscles.
- **Pattern tags on built-in lifts can't be edited by the user.** They are catalog data. Custom
  lifts keep their existing editable tags.
- **No incline direction, and no upper/lower chest split.** Both were considered and declined.
  An incline of 45° or less presses at least as close to perpendicular to the torso as to
  parallel, and the chest split is a vocabulary change to revisit only if it proves needed.
- **Other volume measures.** No per-muscle volume targets or landmarks, no trends across weeks or
  cycles, and no reps × load (tonnage) volume.
- **Warm-ups in logged data.** Set kind is not stored (`docs/domain-model.md` §4), so Done counts
  every logged row for the lift. The logger itself logs only working sets.

## Open Questions

- ~~Should a Manage Lifts swap inherit the replaced lift's prescription on the workout detail and
  timer pages as well?~~ **Resolved in [#1014](https://github.com/merickvaughn/lifting-logbook/issues/1014): yes.**
  A swap inherits the replaced slot's whole prescription (sets, reps, AMRAP, warm-up and
  decrement %, increment, activation), priced from the replacement's own training max. The rule
  is `applyLiftOverrides` in `@lifting-logbook/core`. It returns each swap's `replaces` and where
  each stored lift name's logged sets now belong, following chains of swaps. The current-week
  counts (#1019) should call it on each workout's overrides rather than re-implement the swap
  table, so the dashboard and the workout pages agree. Its cycle-wide override read must return
  each workout's overrides in the order each was last written, as `getOverrides` does; otherwise
  a chain resolves differently on the dashboard.

## References

- Pelland, J. C., Remmert, J. F., Robinson, Z. P., Hinson, S. R., Zourdos, M. C. "The Resistance
  Training Dose Response: Meta-Regressions Exploring the Effects of Weekly Volume and Frequency on
  Muscle Hypertrophy and Strength Gains." *Sports Medicine* (2025).
  [doi:10.1007/s40279-025-02344-w](https://link.springer.com/article/10.1007/s40279-025-02344-w).
  It compares three ways of counting indirect sets: 0 (*direct*), 0.5 (*fractional*) and 1
  (*total*). This proposal uses the fractional method.
- Rodríguez-Ridao, D. et al. "Effect of Five Bench Inclinations on the Electromyographic
  Activity of the Pectoralis Major, Anterior Deltoid, and Triceps Brachii during the Bench Press
  Exercise." *IJERPH* 17(19):7339 (2020).
  [doi:10.3390/ijerph17197339](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7579505/). Upper-pec
  activity peaks at a 30° incline, and above 45° the anterior deltoid takes over. This is why
  incline is treated as a muscle-emphasis question here, not as a separate direction.
- r/bodyweightfitness, [Recommended Routine](https://redditbwf.github.io/wiki/recommended_routine.html).
  It pairs dips with pull-ups and push-ups with rows. This is a community convention, not
  research, and it matches the torso-relative classification of the dip.
- [`docs/domain-model.md`](../domain-model.md): §2 on the lift taxonomy (including divergence D8)
  and §4 on prescribed vs. logged sets.
- [ADR-002: Ports and adapters](../adr/ADR-002-ports-and-adapters.md).
