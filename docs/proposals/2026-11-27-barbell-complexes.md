# Proposal: Barbell Complexes

**Status:** `accepted`
**Date:** 2026-11-27
**Issue:** [#1493](https://github.com/merickvaughn/lifting-logbook/issues/1493) ([#1494](https://github.com/merickvaughn/lifting-logbook/issues/1494)–[#1496](https://github.com/merickvaughn/lifting-logbook/issues/1496))

---

## Problem

A barbell complex is several lifts done back to back with one bar and one weight, for a number of
rounds (Power Clean × 5, Front Squat × 5, Push Press × 5, three rounds at 95). The app has no idea
what a complex is. A logged set belongs to one lift, nothing groups sets, and a program row plans
one lift. The only place complexes are handled is the one-off sheet converter
(`scripts/convert-lifting-reference.mjs`, #1478, #1482), which writes each round as one ordinary
set of each component with the complex's name in the set's notes, and nothing reads that note.

So complex sets work against the training maxes. The complex weight is limited by its weakest
lift and is well below most components' maxes, yet:

- `updateMaxes` reads set 1 of a component as a normal attempt and proposes `complex weight +
  increment` as the new max. That is lower than the real one, so every complex raises a false
  "max reduction" for review.
- The missing-max offer (#1246) estimates a max from a lift's best recent set. A lift done only in
  complexes gets a max estimated from the complex weight.
- Sets are numbered per lift per day, so a lift done on its own and in a complex the same day has
  its complex sets counted in the same session, which `linear` and `double` progression read.

There is also no way to plan a complex's weight from the maxes, or to log one without entering
every round of every component as its own set.

## Proposed Solution

Make the complex a first-class part of the logbook, with its weight tied to the training maxes by
the weakest-link rule:

- **Complex sets are tagged.** A logged set can name the complex and the round it belonged to.
  Component sets stay ordinary sets of their own lifts, so per-lift history and volume keep
  working.
- **Tagged sets never move or estimate a lift's max.** They are left out at the same gate that
  already keeps a lift's later occurrences and `none` modifications out (`movesLiftMax`), so they
  are out of the missing-max estimate and out of the session a `linear` or `double` lift is judged
  on, even when they share its set numbers. A lift's last session, which plans its next one, skips
  them too.
- **Import and export carry the tag** as optional `Complex` and `Round` columns, and the converter
  writes them.
- **A lifter can define a complex** (a name and its components in order, each with its reps) and a
  program can plan one. Its weight is a percentage of the **lowest** component max, rounded the same
  way as any planned set, and the workout shows which lift limits it. A component with no max
  leaves the complex unplanned and offers to set that max (#1246).
- **A complex is logged as one card**: the weight once, a tap per completed round, and each
  component's reps prefilled from the definition and editable. It saves tagged component sets.

There is no separate complex max: a complex gets heavier when its weakest lift does.

## Acceptance Criteria

- [ ] A set tagged with a complex does not move its lift's training max or a modification's own
  max, and raises no reduction flag: a `packages/core` test with a tagged set 1 below the max
  returns it unchanged and unflagged, and the same set untagged is flagged.
- [ ] A tagged set feeds no missing-max estimate: a `missingTrainingMaxes` test where a lift's only
  sets are tagged offers no estimate from them.
- [ ] `lift_record` has nullable `complex` and `complexRound` columns, added by a migration, and the
  API reads and writes them (DB e2e test).
- [ ] The lift-record import accepts optional `Complex` and `Round` columns and the export writes
  them: a core round-trip test.
- [ ] The converter writes `Complex` and `Round` for every expanded complex:
  `node --test scripts/convert-lifting-reference.test.mjs`.
- [ ] A lifter can create, edit and delete a complex definition (API e2e test and web component
  test).
- [ ] A program can plan a complex, and its planned weight is the lowest component max times the
  row's percentage, rounded to the row's increment: a planning unit test with three components
  whose lowest max decides the weight.
- [ ] The workout page names the limiting lift, and a complex with a component lacking a max shows
  unplanned with the offer to set it (web component test).
- [ ] The complex logging card records rounds and saves one tagged set per component per round
  (web component test and Playwright e2e).

## Out of Scope

- A training max of the complex's own. Decided against: weakest-link loading moves with the lifts.
- Tagging complex sets already imported before this ships. They carry the complex's name in their
  notes, so a one-off backfill can tag them later if wanted.
- Complexes with a different weight per component, or timed complexes (EMOM, AMRAP rounds for time).
- Reading complexes from the column-per-lift sheets, which give no reps per component.

## Sequence

1. Tag complex sets, keep them out of max logic, carry the tag through import, export and the
   converter.
2. Complex definitions, a program row that names a complex, and weakest-link planning.
3. The complex logging card.

## References

- [ADR-041 — Lift modification storage](../adr/ADR-041-lift-modification-storage.md): the existing gate on which
  sets move which max.
- [#1027](https://github.com/merickvaughn/lifting-logbook/issues/1027): occurrences of one lift in a
  workout.
- [#1246](https://github.com/merickvaughn/lifting-logbook/issues/1246): the missing-max offer.
