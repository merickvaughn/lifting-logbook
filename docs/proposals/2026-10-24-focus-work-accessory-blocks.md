# Proposal: Focus Work — Accessory Blocks Layered onto Every Workout

**Status:** `draft`
**Date:** 2026-10-24
**Issue:** [#1053](https://github.com/merickvaughn/lifting-logbook/issues/1053). Sub-issues: [#1054](https://github.com/merickvaughn/lifting-logbook/issues/1054), [#1055](https://github.com/merickvaughn/lifting-logbook/issues/1055), [#1056](https://github.com/merickvaughn/lifting-logbook/issues/1056), [#1057](https://github.com/merickvaughn/lifting-logbook/issues/1057), [#1058](https://github.com/merickvaughn/lifting-logbook/issues/1058), [#1059](https://github.com/merickvaughn/lifting-logbook/issues/1059), [#1060](https://github.com/merickvaughn/lifting-logbook/issues/1060).

---

## Problem

The Consistent Intermediate Lifter runs a structured program, with Reverse Pyramid Training as the
main case. The program sets the main lifts. Accessory work sits outside the program, and it is
where these lifters bring up a lagging area: shoulders for a month, calves for a quarter. Today the
app has nowhere to record that intent. The lifter keeps the plan in their head or in a notes app,
picks accessories by hand each session, and gets no help when the accessory plan collides with the
program. Two common collisions:

- **Overlap.** On a day that already has overhead pressing, a shoulder-focus month adds more
  front-delt work.
- **Session length.** Three accessory focuses stacked on a heavy day turn a 60-minute session into
  a 90-minute one.

The program timeline can't hold this plan either. A program is a ladder of Program → Macrocycle →
Mesocycle → Week → Workout → Lift slot → Set ([domain model](../domain-model.md)). Accessory focus
follows the calendar ("this month", "this quarter"), not mesocycle boundaries. It should keep going
when a mesocycle ends and should not reset when a new macrocycle begins.

This affects all three jobs. Job 1 (log a workout in under 2 minutes) suffers when accessories are
picked and typed by hand. Job 2 (know what weight to use next session) has no answer for
accessories. Job 3 (track progress within a session or block) has no record of whether a focus
month actually moved anything.

## Proposed Solution

Add **focus work**: accessory blocks that the user configures. Each block targets one muscle area
for a calendar month or quarter, or for one month or quarter from a custom start date. Focus blocks
belong to the user, not to a program, and run on their own timeline, separate from the program's
macrocycles and mesocycles. They are layered onto every workout of whichever program is active.

The spec is the three-screen prototype in the Claude Design handoff bundle (Focus Work.html,
2026-10-24).

### Staying inside the product non-goal

The product requirements rule out automated programming generation: users configure their program
parameters and the app applies the math. Focus work stays inside that rule:

- The user picks every focus block's area, period, priority, lift pool, include rules, overlap
  behavior, progression, timer, and what happens when the block ends.
- The app only applies those rules to each day. It resolves which pool lifts are eligible, detects
  overlap from muscle tags, computes weights from the progression the user chose, and totals sets
  and minutes.
- The default pool offered when a block is created is a starting point that the user edits. It is
  not a prescription.
- The daily focus guide is advisory. Trimming happens only when the user presses **Trim**, and
  every trim can be undone.

### Terminology

In the UI, "Block" already means a mesocycle ([glossary](../glossary.md)). To avoid confusion:

- The new concept is always called a **focus block** in UI copy, docs, code identifiers, and API
  routes. Bare "block" stays reserved for the program's mesocycle.
- The feature as a whole is **focus work**.
- `docs/glossary.md` and its in-app mirror (`apps/web/lib/glossary.ts`, served at `/glossary`) gain
  a **Focus block** entry. It says that focus blocks follow the calendar, not the program's
  mesocycles, and continue across mesocycle and macrocycle boundaries.

### Areas

A focus block targets one of eight areas. Each area maps onto the 17-group `MUSCLE_GROUPS`
vocabulary introduced by the [weekly sets per muscle group proposal](2026-09-25-weekly-sets-per-muscle-group.md):

| # | Area | Muscle groups |
|---|---|---|
| 1 | Shoulders | Front Delts, Side Delts, Rear Delts |
| 2 | Biceps | Biceps |
| 3 | Triceps | Triceps |
| 4 | Back | Lats, Upper Back, Traps, Lower Back |
| 5 | Chest | Chest |
| 6 | Calves | Calves |
| 7 | Glutes | Glutes |
| 8 | Core | Core |

A lift **trains the area** when one of its primary muscles is in the area's groups. Primary muscles
are resolved through the existing muscle resolver, so the user's per-lift overrides in
`LiftMetadata` apply. Secondary muscles do not count toward overlap.

### Focus block fields

| # | Field | Values |
|---|---|---|
| 1 | Area | One of the eight areas above |
| 2 | Period | Monthly, Quarterly |
| 3 | Alignment | Calendar (first of the month or quarter), or Custom start date (one month or quarter from that date) |
| 4 | Priority | Ordered 1..n among active focus blocks, reordered with up and down controls |
| 5 | Selection mode | Rules, Rotate, Fixed, I pick |
| 6 | Overlap mode | Swap, Reduce, Skip, Do it anyway |
| 7 | Progression | Double progression, Fixed, Percent of training max, RPE (rate of perceived exertion) |
| 8 | Lift pool | Ordered list of pool entries (below) |
| 9 | Timer | Setup, set, and rest durations in seconds |
| 10 | When it ends | Prompt me, or Auto-roll to a chosen next area |

**Status** (queued, active, ended) is never stored. It is derived from the block's start and end
dates against today's date: queued before its start date, active through its end date, ended after
that.

### Selection modes

Selection decides which eligible pool lifts appear on a given day. A pool entry is eligible if its
include rule admits it for that day.

| # | Mode | Behavior |
|---|---|---|
| 1 | Rules | Every eligible pool lift |
| 2 | Rotate | One eligible lift per session, cycling through the pool in order. Entries marked **Always** are added on top of the rotation. |
| 3 | Fixed | The first eligible lift every session, plus any **Always** entries |
| 4 | I pick | Eligible lifts appear as chips on the workout page, and the user picks on the day |

The user can override the selection mode for a single day on the workout details page. The
override applies to that workout only.

### Pool entries

Each pool entry names a catalog or custom lift and carries an include rule and a prescription.

| # | Include rule | Meaning |
|---|---|---|
| 1 | Follows selection | Eligible, chosen according to the block's selection mode |
| 2 | Always | Included every session, whatever the selection mode |
| 3 | Only when a named program lift isn't planned | Eligible only on days when the named program lift is not planned |
| 4 | Swap target only | Never selected on its own. Used only as the replacement when the Swap overlap mode fires. |
| 5 | Off | Kept in the pool but never used |

Each entry's prescription has sets, plus a rep range (for double progression) or a fixed rep count,
and, depending on the progression, a weight, a training max and percent, or an RPE target. Under the
Swap overlap mode, an entry can also name the complementary lift it swaps to.

### Overlap

When one or more of the day's planned program lifts train the focus block's area as a primary mover,
the block applies its overlap mode:

| # | Overlap mode | Effect on that day |
|---|---|---|
| 1 | Swap | Each selected focus lift is replaced by its configured complementary lift |
| 2 | Reduce | Each selected focus lift does one set fewer, with a minimum of 1 |
| 3 | Skip | No focus work for that area today |
| 4 | Do it anyway | No change |

The workout page shows an overlap note naming the planned lift that triggered it.

### Progression

| # | Progression | Weight and reps shown |
|---|---|---|
| 1 | Double progression | Works within a rep range. When every set reaches the top of the range, weight goes up next session. The workout page shows last session's reps. |
| 2 | Fixed | The weight the user set |
| 3 | Percent of training max | Training max × percent, rounded to a loadable plate combination per the [training-max precision standard](../standards/training-max-precision.md) |
| 4 | RPE | Target RPE, shown with reps in reserve (10 − RPE) |

A user-entered weight is a directly known weight, so it is never rounded, as the same standard
requires.

### Daily focus guide

The user sets two daily guide values on their user settings: extra sets per day and focus minutes
per day. The guide is advisory only.

When a day's focus work goes over either value, the workout page shows an advice card. It suggests
trimming the last lift of the lowest-priority focus block and shows the totals that would result.
It has two buttons, **Trim** and **Keep everything**. A trim applies to that day only, can be undone,
and is stored with the day's other focus choices. Dismissing the card is stored for that day too.

A focus lift's time comes from its block's timer: sets × (setup + set) + (sets − 1) × rest, plus one
rest before the next lift.

### Screens

#### Setup page — Programs › *program* › Focus work

- **Renewal prompt.** Appears when a Prompt-me focus block has 10 days or fewer left. Actions:
  **Renew for next month/quarter**, **Queue** a different area, **Let it end**.
- **Active focus blocks** in priority order, each an expandable card for editing every field above,
  with up and down controls for priority.
- **+ Add focus block** with an area picker. The default pool is up to 3 accessory lifts whose
  primary muscle is in that area's groups.
- **Up next.** Queued and auto-rolled focus blocks, each with **Cancel**.
- **Daily focus guide** steppers for extra sets per day and focus minutes per day.
- **This week.** Each session's focus lifts and its focus sets and minutes, flagging sessions over
  the guide.

#### Workout details page

- **Header.** Date, then program · block · week · day, and an **Upcoming** badge for future
  workouts.
- **Summary grid.**

  | # | Tile | Content |
  |---|---|---|
  | 1 | Planned | Program working sets for the day |
  | 2 | Focus | Focus sets against the guide |
  | 3 | Estimated time | Planned plus focus |
  | 4 | Focus time | Focus minutes against the guide, in warning color when over |

- **Placement:** Before, After, or Interleave.
  - **Before and After** show Planned and Focus work as two modules. Dragging swaps their order.
  - **Interleave** shows one mixed **Today's order** list with drag-to-reorder and **Reset order**,
    plus a separate **Focus controls for today** module.
- **Focus groups.** One per active focus block. Each shows the area, the range label, the priority,
  a per-day selection-mode select, the overlap note, pick chips (for I pick), and skipped and
  trimmed rows with their reasons.
- **Focus lift rows** expand to show "Focus sets · *progression*", with the per-set prescription and
  a hint that includes the block's timer.
- Every drag-to-reorder interaction also has keyboard-operable move up and move down controls.

#### Calendar page

A new **Calendar** navigation entry opens a Gantt view:

- **Range and header.** From about one month back to six months ahead, with a month header and a
  **Today** marker.
- **Program row.** Training blocks (mesocycles) and deloads.
- **Focus lanes.** A **Focus** divider, then one lane per focus block series, ordered by priority.
  Bars are styled **Active** (solid), **Ended** (faded), or **Queued** (dashed).
- **Detail card.** Tapping a bar opens a card:

  | # | Bar | Detail card |
  |---|---|---|
  | 1 | Program phase | Dates, weeks |
  | 2 | Active focus block | Progress bar ("Week *n* of *m*"), selection, overlap, progression, pool, when it ends, renewal prompt, **Edit in Programs** |
  | 3 | Ended focus block | Summary: sessions, sets, volume, personal records with deltas |
  | 4 | Queued focus block | **Cancel** |

The ended-block summary is computed from logged lift records on the block's pool lifts within its
date range:

- Sessions are distinct workout dates.
- Volume is the sum of weight × reps.
- A personal record is a pool lift's best within the range compared against that lift's best before
  the range starts.

### Persistence

Focus blocks are durable configuration that must follow the user across devices. Timer state is
different: [ADR-035](../adr/ADR-035-client-side-rest-timer-state.md) deliberately keeps it in
`localStorage` because it is transient. Focus blocks are stored on the server, mirroring the
custom-lift feature end to end:

- **Tables**, each with a `userId` column and forced row-level security:
  - `focus_block` holds the block's fields, with its lift pool and timer as validated JSON columns.
    A unique constraint on (user, series, start date) keeps auto-roll successors from duplicating.
  - `focus_day_state` holds per-workout choices, keyed by (user, program, macrocycle number, workout
    number), the same key the existing workout override side-tables use
    ([domain model](../domain-model.md)). It covers the selection-mode override, picks, trims,
    placement, interleaved order, and dismissed advice.
  - The daily focus guide is two new columns on `UserSettings`.
- **Port, adapters, endpoints, client.** A port with Prisma and in-memory adapters; endpoints for
  focus block create, list, update, delete and priority reorder; the guide; a workout's focus plan
  and day state; and an ended block's summary. Matching methods go in `packages/api-client`.
- **Auto-roll.** Successors are created idempotently on read: when an Auto-roll focus block has
  ended and its series has no successor, the read creates one for the chosen next area, starting the
  day after the predecessor ends.

The pure domain logic lives in `packages/core/src/focus` with no infrastructure dependencies: date
ranges and derived status, area-to-muscle mapping, eligibility, selection, overlap, progression,
guide totals, trim suggestions, and the ended-block summary.

### Logging and the timed workout

Focus lifts are logged as normal lift records, so they appear in history, feed the next session's
double progression, and feed the ended-block summary. They join the timed-workout queue using each
focus block's own setup, set, and rest durations.

### Catalog additions

Today the lift catalog has no lift with Core as a primary muscle and no triceps accessory, so
several areas could not get a default pool. About 20 accessory lifts are added, skipping any already
in the catalog, each tagged with primary and secondary muscles from `MUSCLE_GROUPS`:

Lateral Raise, Upright Row, Arnold Press, Hammer Curl, Incline Dumbbell Curl, Rope Pushdown,
Overhead Extension, Skull Crusher, Chest-Supported Row, Straight-Arm Pulldown, Lat Pulldown, Cable
Fly, Standing Calf Raise, Seated Calf Raise, Hip Thrust, Cable Pull-Through, Cable Crunch, Hanging
Leg Raise.

### Delivery plan

Seven pull requests under one top-level issue, each closing its own sub-issue:

| # | Pull request | Scope | Depends on |
|---|---|---|---|
| 1 | Catalog accessories | About 20 accessory lifts with muscle tags | — |
| 2 | Core domain | `packages/core/src/focus` | — |
| 3 | API persistence and endpoints | Tables, port, adapters, endpoints, api-client | 2 |
| 4 | Setup page | Programs › *program* › Focus work | 3 |
| 5 | Workout details module | Summary grid, placement, focus groups, per-day controls, advice card | 3 |
| 6 | Calendar page | Gantt view, detail cards, Calendar navigation entry | 3 |
| 7 | Logging and timed workout | Focus lifts logged and queued with each focus block's timer | 5 |

## Acceptance Criteria

- [ ] **Terminology**
  - [ ] UI copy, docs, code identifiers, and API routes say "focus block"; bare "block" still
    refers only to a mesocycle.
  - [ ] `docs/glossary.md` and `apps/web/lib/glossary.ts` have a **Focus block** entry.
- [ ] **Catalog**
  - [ ] The catalog contains the listed accessory lifts, with no duplicates of lifts already present.
  - [ ] Each of the eight areas has at least two catalog accessory lifts whose primary muscle is in
    the area's groups.
- [ ] **Core domain**
  - [ ] The area-to-muscle mapping matches the Areas table, and overlap detection uses primary
    muscles resolved through the muscle resolver, including user overrides.
  - [ ] Derived status is correct for calendar-aligned and custom-aligned monthly and quarterly focus
    blocks, including month-end and year-end boundaries.
  - [ ] Each selection mode and include rule produces the documented lifts.
  - [ ] Each overlap mode produces the documented effect, and Reduce never drops a lift below 1 set.
  - [ ] Percent-of-training-max weights round to loadable plate combinations, and user-entered
    weights are never rounded.
  - [ ] Guide totals and the trim suggestion (last lift of the lowest-priority focus block) are
    correct.
  - [ ] The ended-block summary counts only lift records inside the date range and compares against
    each lift's best before it.
- [ ] **Persistence and API**
  - [ ] Both new tables enforce forced row-level security, verified by database end-to-end tests
    run under the restricted application role, not the superuser.
  - [ ] Each new endpoint has an in-memory end-to-end test in the same pull request.
  - [ ] Per-workout choices persist per (program, macrocycle number, workout number) and don't leak
    into other workouts.
  - [ ] Auto-roll successors are created once, even under repeated reads.
  - [ ] `packages/api-client` exposes typed methods for every endpoint.
- [ ] **Setup page**
  - [ ] The renewal prompt appears for Prompt-me focus blocks with 10 days or fewer left, and each
    action works.
  - [ ] Priority can be changed with up and down controls.
  - [ ] Adding a focus block pre-fills up to 3 accessory lifts for the chosen area.
  - [ ] Up next lists queued and auto-rolled focus blocks, each with a working Cancel.
  - [ ] This week flags sessions over the daily guide.
- [ ] **Workout details page**
  - [ ] The summary grid shows planned sets, focus sets against the guide, estimated time, and focus
    time against the guide, in warning color when over.
  - [ ] Before, After, and Interleave render as described, and placement and order persist per
    workout.
  - [ ] The per-day selection override, picks, trims, and advice dismissal persist per workout, and
    trims can be undone.
  - [ ] Every drag-to-reorder action has a keyboard alternative.
  - [ ] If the focus plan can't be loaded, the page still shows the planned lifts, with a notice.
- [ ] **Calendar page**
  - [ ] A Calendar navigation entry opens the Gantt view with a Today marker.
  - [ ] The program row shows mesocycles and deloads; focus lanes are ordered by priority with
    Active, Ended, and Queued bar styles.
  - [ ] Each bar type opens its detail card, and Cancel on a queued focus block works.
- [ ] **Logging and timed workout**
  - [ ] Focus lifts are logged as normal lift records and appear in lift history.
  - [ ] Focus lifts join the timed-workout queue with their focus block's setup, set, and rest
    durations.
- [ ] **Testing and observability**
  - [ ] New pages and interactive features have Playwright coverage.
  - [ ] Every client-side focus mutation reports caught errors through `logClientError`.
- [ ] **ADR.** An ADR records server-persisted focus blocks on an independent timeline, the
  area-to-muscle mapping, and date-derived status.

## Out of Scope

- The mobile app (`apps/mobile`).
- Per-muscle volume targets.
- Focus sets contributing to the weekly sets per muscle group table (candidate follow-up).
- Deload-aware focus work. Focus work continues through program deload weeks unless the user
  changes it (see Open Questions).
- Multiple areas per focus block, and sharing focus blocks between users.
- Pre-existing defects found during exploration, filed as separate issues: the undefined CSS tokens
  `--color-accent-text` and `--font-weight-semibold`; `LiftMetadata` not persisting secondary muscle
  overrides; seed data using free-text muscle names.

## Open Questions

1. Should focus work pause, or reduce, during program deload weeks? This proposal continues it
   through deloads unless the user edits the focus block.
2. Should focus sets count toward the weekly sets per muscle group table, using the same fractional
   counting as [ADR-036](../adr/ADR-036-muscle-group-defaults-and-fractional-set-counts.md)?
3. Should the double progression increment be fixed at 5 lbs, as in the prototype, or follow the
   user's default weight increment setting?

## References

- Claude Design handoff bundle, Focus Work.html, 2026-10-24 (prototype source; not linked).
- [Domain model](../domain-model.md): the program ladder, workout override side-tables, and muscle
  groups as a lift axis.
- [Glossary](../glossary.md): "Block" as the UI word for a mesocycle.
- [Proposal: Weekly Sets per Muscle Group](2026-09-25-weekly-sets-per-muscle-group.md) (#1013): the
  17-group `MUSCLE_GROUPS` vocabulary.
- [ADR-035: Client-side rest-timer state](../adr/ADR-035-client-side-rest-timer-state.md).
- [ADR-036: Muscle-group defaults and fractional set counts](../adr/ADR-036-muscle-group-defaults-and-fractional-set-counts.md).
- [Training-max precision standard](../standards/training-max-precision.md).
