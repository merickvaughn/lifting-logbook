# User Guide

This guide is for lifters using the Lifting Logbook web app. It walks through every screen the app currently ships, in the order you would encounter them. If you are looking for architecture, deployment, or contributor documentation, start at [docs/README.md](README.md) instead.

## Table of contents

1. [What this app is for](#what-this-app-is-for)
2. [Getting started](#getting-started)
3. [Macrocycle dashboard](#macrocycle-dashboard)
4. [Logging a workout](#logging-a-workout)
5. [Workout detail](#workout-detail)
6. [Training maxes](#training-maxes)
7. [Strength goals](#strength-goals)
8. [Workout schedule](#workout-schedule)
9. [History](#history)
10. [Programs](#programs)
11. [Glossary](#glossary)

---

## What this app is for

Lifting Logbook runs a structured strength program for you. You pick a program (5/3/1 and its common variants are built in), tell it your current training maxes, and it lays out a macrocycle — one full run of the program — with the right sets, reps, and weights for each session. You log what you actually lifted, and over time your training maxes adjust as you get stronger.

The home screen at `/` is a small landing card with three shortcuts: **Current Macrocycle**, **Training Maxes**, and **Get Started**. If you have never used the app before, start with **Get Started**.

---

## Getting started

### Sign in

The app uses Clerk for authentication. Visit `/sign-in` and follow the prompts.

### Onboarding

`/onboarding` is a four-step wizard. The progress dots at the top of the page show where you are.

| Step | What you do |
|---|---|
| 1. Choose Method | Pick **Estimate** (enter a recent heavy set and let the app derive your 1RM with the Brzycki formula) or **Manual** (enter your 1RM directly). |
| 2. Enter Lifts | Enter weight (and reps, if estimating) for the three core lifts: Bench, Squat, Deadlift. **Next** stays disabled until every field has a positive number. |
| 3. Confirm Maxes | Review the computed 1RMs. Hit **Continue to Programs** to advance. |
| 4. Choose Program | Filter the catalog by experience level (Beginner / Intermediate / Advanced), pick a program card, and confirm. The app creates your first macrocycle and redirects you into it. |

You can step back at any point before the program-selection step with the **Back** button.

---

## Macrocycle dashboard

**Route:** `/macrocycle` (redirects to your active macrocycle) → `/macrocycle/<n>`

A **macrocycle** is one complete run through your program (12 weeks for 5/3/1). Terms like macrocycle, mesocycle and block are explained on the in-app [Glossary](#glossary) page — every heading with a small **?** next to it links straight to its entry.

The dashboard is a grid: one row per training week, one cell per workout. When a program repeats in blocks longer than a week — 5/3/1's 3-week mesocycles — the weeks are grouped under **Block** headings (Block 1 · Weeks 1–3, and so on). Each cell shows the workout's date, the lifts planned for it, and a status badge:

| Badge | Meaning |
|---|---|
| **Upcoming** | Scheduled for today or later, not yet logged |
| **Completed** | At least one set has been logged for this workout |
| **Missed** | The date has passed and nothing was logged |
| **⊘ Skipped** | You explicitly marked the workout skipped (see [Workout detail](#workout-detail)) |

Click any cell to open that workout's detail screen.

Two related routes give you a broader view of the macrocycle:

- `/macrocycle/<n>/program` (**Current Program**) — the program's full lift list and bulk-import form for backfilling records.
- `/macrocycle/<n>/plan` (**Macrocycle Plan**) — the start date and estimated completion of the macrocycle, plus its mesocycles with status icons. 5/3/1 shows four 3-week mesocycles; programs that repeat a single week (Leangains, RPT) show one **Training** span.

---

## Logging a workout

**Route:** `/macrocycle/<n>/workout/<m>`

This is the page you'll use most. For each lift in the workout it shows:

- **Warm-up sets** — computed from your training max and the program spec. These are reference numbers; you don't log them.
- **Working sets** — what you actually perform. Each row is a weight and a rep count.
- **AMRAP** ("as many reps as possible") — the last set of certain lifts is flagged AMRAP. You enter the rep count you actually hit; AMRAP performance is what the app uses to decide whether to bump your training max later.

If any lift in the workout is a bodyweight component (chin-ups, pull-ups, dips), a **body weight gate** asks you to confirm or enter your body weight for this workout before the form unlocks. The gate is keyed on the workout's date, not on today — so if you enter a body weight, then later open a different-dated workout (e.g., backfilling last week or logging a rescheduled session), the gate fires again for that date.

Submitting writes a `LiftRecord` per set. As soon as the first set is logged, the dashboard badge flips to **Completed**. Once every working set has a record, the page itself becomes read-only.

---

## Workout detail

**Route:** `/macrocycle/<n>/workout/<m>/detail`

A summary view with the workout's status badge, date, week number, total lifts, total sets, and an expandable list of planned lifts (warm-up plus work sets, with weights filled in from your current training max).

Actions available from here:

- **Manage Lifts** (`.../detail/manage-lifts`) — edit the lifts in the workout. The list lets you add, remove, or reorder lifts. From there you can:
  - **Pick** (`.../manage-lifts/pick?action=add|replace&replacing=<lift>`) — type-ahead search the built-in catalog of ~20 barbell, dumbbell, and bodyweight movements by name. Confirm to add to the workout or replace an existing slot.
  - **Edit** (`.../manage-lifts/edit/<lift>`) — change sets, reps, or intensity modifiers for a specific lift.
- **Start Logging** — shortcut to the logging page above. Hidden once the workout is completed or skipped.
- **Reschedule** — set a different date for this workout. The new date is treated as the effective date everywhere (dashboard cell, status calculation, etc.) and the original is shown in a "(rescheduled)" annotation.
- **Skip** — mark the workout skipped with a reason. Skipped workouts show the **⊘ Skipped** badge and stay in the macrocycle for the record. Hidden once the workout is completed.

There is also `/macrocycle/<n>/workout/<m>/detail/<lift>` — a per-lift drilldown showing your current training max, the training max history for that lift, and every set you've ever logged for it.

---

## Training maxes

**Route:** `/settings/training-maxes`

Your training max is a working-weight number, usually around 85–90 % of your true one-rep max, that every percentage in the program is calculated from. It is not your PR — it is intentionally conservative so the program is repeatable.

The page has two parts:

- **Training Maxes Editor** — one input per lift. Saving writes a new entry to history and updates the value used by future workouts.
- **Max History** — a table of every change with the date and a PR badge when the new value is your highest ever. Useful for sanity-checking long-term progress.

---

## Strength goals

**Route:** `/settings/strength-goals`

Optional targets per lift. Two goal types:

- **Absolute** — a specific weight (e.g., "I want a 405 lb deadlift").
- **Relative** — a multiple of body weight (e.g., "I want a 2× body-weight squat"). Relative goals require your current body weight, which you can enter at the top of the page.

Progress is shown as a percentage of your training max against the goal, with a strength-tier label on the standard novice → intermediate → advanced → elite scale.

---

## Workout schedule

**Route:** `/settings/schedule`

Optional. If you don't set a schedule, each workout's date is set when you log it. If you do set one, the app distributes upcoming workouts across the calendar for you.

Three modes:

- **No schedule** — dates are decided at log time.
- **Fixed days** — pick the days of the week you train (Mon–Sun). The app schedules workouts onto the next available training day.
- **Rotating weeks** — define up to eight different weekly patterns that cycle. Useful if you train M/W/F one week and Tue/Thu/Sat the next, for example.

A schedule only sets the dates. Your program's workouts keep their order, one per training day, so a schedule that trains more or fewer days a week than your program finishes it sooner or later. For example, 5/3/1's 24 workouts on a Mon/Wed/Fri schedule take eight calendar weeks instead of twelve. The Macrocycle Plan's estimated completion date follows your schedule. A schedule you set or change applies to the next macrocycle you start.

The form validates that you've picked at least one day before saving, and re-seeds from the server response after save so you see the canonical stored value.

---

## History

**Route:** `/history`

Two tabs:

- **Lift History** — every set you've ever logged. Search by lift name, filter by lift, sort by date. PR rows are flagged.
- **TM Timeline** — the chronological feed of training max changes across all lifts, with the percentage delta from the previous value.

---

## Programs

**Route:** `/programs`

Two tabs:

- **Browse Programs** — the built-in catalog (5/3/1, BBB and other 5/3/1 variants, etc.). The card for your active program is highlighted. Switching programs opens a confirmation dialog explaining that your lift history and training maxes for the current program are kept.
- **My Programs** — custom programs you have authored. The editor lets you define week-by-week percentage and rep schemes, save the program, and (separately) switch the active program to it.

---

## Glossary

The app has its own glossary at `/glossary` (the **Glossary** link in the top navigation), and headings throughout the app link into it with a small **?**. It also explains what the same words mean in other programs and coaching writing. The developer version, with sources, is [docs/glossary.md](glossary.md).

**How training time is organized**, largest to smallest:

- **Macrocycle** — one complete run through a program, start to finish (12 weeks for 5/3/1 here). Starting the next macrocycle, which will recalculate training maxes from your logged sets, is not available in the app yet.
- **Mesocycle (block)** — a block of weeks that repeats as a unit inside a macrocycle. 5/3/1 here uses four 3-week mesocycles; Leangains and RPT repeat a single week.
- **Microcycle (week)** — one training week.
- **Workout (session)** — one training day's lifts, numbered in order across the macrocycle.

**Words used differently elsewhere:**

- **Cycle** — the app avoids the bare word. Jim Wendler's 5/3/1 "cycle" is a 4-week block (three work weeks plus a deload) — a mesocycle here. Juggernaut's and Smolov's "cycle" is a whole 13–16-week program — a macrocycle here.
- **Wave** — usually a block of weeks (Juggernaut's 10s/8s/5s/3s waves) — a mesocycle here. "Wave loading" also names sets that climb, drop back and climb again within one workout.
- **Phase** — a stretch of training defined by its goal (hypertrophy, peaking); one mesocycle or several.

**Weights and sets:**

- **1RM (one-rep max)** — the heaviest weight you can lift once for a given exercise. The onboarding flow can estimate it from a heavier-rep set using the [Brzycki formula](https://en.wikipedia.org/wiki/One-repetition_maximum#Brzycki).
- **Training max (TM)** — a working number, typically 85–90 % of your 1RM, that every percentage in the program is calculated from. Lower than your true 1RM by design.
- **AMRAP** — "as many reps as possible." The last set of certain lifts is performed to technical failure; the rep count you hit is what drives training-max adjustments.
- **Deload** — a planned lighter week to manage fatigue. Commonly scheduled every fourth week in strength programming generally, but **none of the built-in programs currently schedules one** — deload is a documented non-goal for v1.0 (see [PRD.md](PRD.md)), and no shipped program marks a week as a deload.
- **PR (personal record)** — your best logged result for a lift: the heaviest weight, the most reps, or the highest training max.
- **Bodyweight component** — an exercise where your body weight is part of the load (chin-ups, pull-ups, dips). Logging a workout that includes one triggers the body-weight gate.
- **Brzycki formula** — `1RM ≈ weight × 36 / (37 − reps)`. Reasonably accurate for sets of 1–10 reps.
