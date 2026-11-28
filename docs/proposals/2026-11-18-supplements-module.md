# Proposal: Supplements — Track the Stack by Day Type, with Advisories, History and Suggestions

**Status:** `shipped`
**Date:** 2026-11-18
**Issue:** [#1372](https://github.com/merickvaughn/lifting-logbook/issues/1372)

---

## Problem

Lifters who take supplements keep the stack outside the app: a spreadsheet, notes, or memory. The
owner's lives in a Google Sheet (Nutrition_2026 › Supplements: compound, amount, timing, purpose,
notes, and a product link per row) plus an AI chat thread of recommendations. Neither is tied to
training, so the app can't answer:

- What am I taking before today's session, and what every day?
- Do two products add up to too much of something? Pre-X (300 mg caffeine) plus half a dose of
  Trans4orm (87.5 mg) is ~390 mg on a lift day, near
  [FDA's ~400 mg/day reference](https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much).
- Does a 4:30 PM pre-workout land after my own 3 PM caffeine cutoff?
- What was I taking around a PR?

## Proposed Solution

A **Supplements** module that becomes the source of truth for the stack. The stack is mirrored one
way to a linked Google Sheet the lifter owns.

### What I'm on, by day type

The lifter defines **day types** (Lift day, Rest day, Match day, …), each with an optional session
time; nothing is hard-coded per sport. The page shows, for the selected day type:

- a **supplemental protein** total (whole protein only; free amino acids such as citrulline, taurine
  and glycine don't count, per the
  [ISSN protein position stand](https://jissn.biomedcentral.com/articles/10.1186/s12970-017-0177-8));
- a **Workout** card, always split into **Pre-, Intra- and Post-workout**;
- an **Every day** card split into **Throughout the day**, **Morning**, **Afternoon** (shown only
  when used) and **Night**;
- a collapsible **Pending** list of things the lifter is considering, each with a one-tap **Start**.

Each row shows name and dose; line 2 is key compound · timing; line 3 is the lifter's short note,
styled apart from reference text. Each card has an Item / Your dose header.

### Items, doses and mixes

An **item** is what is taken; it has one or more **doses**, each with a slot, amount, servings and
day types. Creatine taken pre-workout on lift days and throughout the day in broth is one item with
two doses, shown in both slots and tagged "also …". This is the split HL7 FHIR makes between a
medication and its list of dosage instructions
([FHIR Dosage](https://hl7.org/fhir/dosage.html)).

A **mix** is an optional item made of other items (e.g. an all-day broth of sodium, potassium and
citrulline). Its ingredients are its parts' ingredients, so totals are unchanged; it can be split
back into items. Products (Pre-X), single compounds and mixes all expose ingredients the same way:
the Composite pattern ([Gamma et al., *Design Patterns*](https://refactoring.guru/design-patterns/composite)).

### Advisories

Small named rules (the Specification pattern —
[Evans & Fowler](https://martinfowler.com/apsupp/spec.pdf)) flag rows gently, never as errors:

| Rule | Fires when | Source |
|---|---|---|
| Late stimulant | A workout dose with caffeine is on a day whose session time is after the lifter's caffeine cutoff | The lifter's cutoff setting |
| Caffeine total | Caffeine from counted doses that day ≥ 350 mg | [FDA](https://www.fda.gov/consumers/consumer-updates/spilling-beans-how-much-caffeine-too-much) |
| Potassium | Supplemental potassium that day > 3,400 mg (spreading it through the day is noted as fine) | [NIH ODS Potassium](https://ods.od.nih.gov/factsheets/Potassium-HealthProfessional/) |
| Activating at night | Ashwagandha or maca in the Night slot | Catalog caution |
| Missing amount | An active dose has no amount | — |

### Detail panel

Tapping an item opens a panel with: worth-a-look callouts; how you take it (every dose); **where to
buy** (the lifter's links, or a suggested search at the store they link to most, marked "suggested"
with **Keep**); the long note; supplement or nutrition facts; **overlaps** with the rest of the stack
(ingredient · this item · day total); why athletes take it; an evidence rating; cautions; sources.

### Editing

- A full form: name with catalog suggestions, key compound, dose rows, typical range, status, timing,
  short note, protein per serving, category, long note, product links. Reference content (facts,
  uses, evidence, sources) is read-only.
- Autofill writes only fields the lifter hasn't typed in.
- **Edit stack** mode with bulk **Move to…** (per dose), **Combine into mix…**, **Mark active /
  pending** and **Remove**.
- **Replace with…**, plus automatic overlap suggestions when an added item shares ingredients with
  the stack (same slot first, pre-selected only when it supplies at least as much). The lifter
  chooses per replacement: **Move them to Pending** (default; products get discontinued) or
  **Remove them** (restorable from History).
- **Edit days**: day types, session times and the caffeine cutoff.

### History

Every change is appended to a change log beside current state (closer to an audit log than to full
[event sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)). From it: **What was I on?**
for any date, linked from Lift History workouts and PRs; the change list; and **Restore** for
removed items.

### Suggestions in three tiers

1. **Shared catalog** — curated, shared by all users, seeded from the owner's sheet with dose ranges
   and cautions from [NIH ODS](https://ods.od.nih.gov/) fact sheets and evidence levels from the
   [AIS Supplement Framework](https://www.ais.gov.au/nutrition/supplements) and ISSN position stands.
2. **Product labels** — the NIH
   [Dietary Supplement Label Database API](https://dsldapi.od.nih.gov/) (v9) for branded products.
3. **AI suggestion** — when neither matches. The request carries only the typed name, fenced as
   untrusted input; the reply is validated and its sources kept only if https. The item is saved
   **unverified**, excluded from totals and advisories until the lifter confirms it
   ([OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)).

### Import and mirror

- **Import** a supplement sheet through the existing Google Sheets link import
  ([ADR-040](../adr/ADR-040-google-sheets-link-import.md)), with cell hyperlinks becoming product
  links and a review step to mark rows active, pending, or skip.
- **Mirror** the stack one way to a linked Google Sheet the lifter owns. This needs write access the
  app doesn't have today, so it gets its own ADR first.

## Acceptance Criteria

Each sub-issue carries its own detailed checks; at the proposal level:

- [ ] Core: placements, ingredient totals, protein, the five advisory rules, overlap detection and
  history replay are pure functions in `packages/core` with tests (#1373).
- [ ] Storage: per-user tables with forced row-level security, a change log written in the same
  transaction as every change, included in Download My Data (#1374).
- [ ] Catalog: every entry cites at least one primary source (#1375).
- [ ] Page and detail panel render the mockup's layout for lift and rest days, with advisories and
  overlaps (#1376); editing, bulk actions, replacements and mixes work (#1377).
- [ ] History answers "what was I on" for a date and restores removed items, linked from Lift
  History (#1378).
- [ ] The owner's Nutrition_2026 › Supplements tab imports cleanly (#1379).
- [ ] The linked-sheet mirror never blocks a write and never runs until the lifter links a sheet
  (#1380).
- [ ] AI suggestions send only the typed name and never count until confirmed (#1381).

## Out of Scope

- **Medications and interaction checks.** Tracked separately in
  [#1382](https://github.com/merickvaughn/lifting-logbook/issues/1382), after this ships.
- **Daily check-off / adherence tracking.** The page is "what I'm on", not a log of each dose taken.
- **Mobile.** Web first, like the rest of v0.4.
- **Rescaling a product's label facts when the amount text changes.** Servings scale totals; free-text
  amounts don't.
- **Dosing advice.** Advisories are reminders with sources, not medical advice, and the page says so.

## Sequence

1. #1373 core domain → #1374 persistence and API, and #1375 catalog, in parallel.
2. #1376 page and detail panel → #1377 editing → #1381 tiers 2–3.
3. #1378 history, #1379 import and #1380 mirror after #1374.

## Open Questions

- Should AI suggestions a lifter confirms feed a review queue for the shared catalog, or stay on the
  lifter's stack only?
- Which store searches beyond Amazon, iHerb and Target should the default "where to buy" support?

## References

- Mockups: `Supplements.html` and `Supplements - Medications (future).html` in the Lifting Logbook
  Claude Design project (2026-11-18).
- Design notes: "Lifting Logbook — Supplements Module Design" (Claude doc, 2026-11-18).
