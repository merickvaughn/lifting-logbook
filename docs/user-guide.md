# User Guide

This guide is for lifters using the Lifting Logbook web app. It walks through every screen the app currently ships, in the order you would encounter them. If you are looking for architecture, deployment, or contributor documentation, start at [docs/README.md](README.md) instead.

## Table of contents

1. [What this app is for](#what-this-app-is-for)
2. [Getting started](#getting-started)
3. [Cycle dashboard](#cycle-dashboard)
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

Lifting Logbook runs a structured strength program for you. You pick a program (5/3/1 and its common variants are built in), tell it your current training maxes, and it lays out a cycle of workouts with the right sets, reps, and weights for each session. You log what you actually lifted, and over time your training maxes adjust as you get stronger.

The home screen at `/` is a small landing card with three shortcuts: **Current Cycle**, **Training Maxes**, and **Get Started**. If you have never used the app before, start with **Get Started**.

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
| 4. Choose Program | Filter the catalog by experience level (Beginner / Intermediate / Advanced), pick a program card, and confirm. The app creates your first cycle and redirects you into it. |

You can step back at any point before the program-selection step with the **Back** button.

---

## Cycle dashboard

**Route:** `/cycle` (redirects to your active cycle) → `/cycle/<n>`

The dashboard is a grid: one row per training week, one cell per workout. Each cell shows the workout's date, the lifts planned for it, and a status badge:

| Badge | Meaning |
|---|---|
| **Upcoming** | Scheduled for today or later, not yet logged |
| **Completed** | At least one set has been logged for this workout |
| **Missed** | The date has passed and nothing was logged |
| **⊘ Skipped** | You explicitly marked the workout skipped (see [Workout detail](#workout-detail)) |

Click any cell to open that workout's detail screen.

Two related routes give you a broader view of the cycle:

- `/cycle/<n>/program` — the program's full lift list and bulk-import form for backfilling records.
- `/cycle/<n>/plan` — the start and end dates of the cycle plus a phase breakdown (loading, hypertrophy, deload, testing, etc.) with status icons.

---

## Logging a workout

**Route:** `/cycle/<n>/workout/<m>`

This is the page you'll use most. For each lift in the workout it shows:

- **Warm-up sets** — computed from your training max and the program spec. These are reference numbers; you don't log them.
- **Working sets** — what you actually perform. Each row is a weight and a rep count.
- **AMRAP** ("as many reps as possible") — the last set of certain lifts is flagged AMRAP. You enter the rep count you actually hit; AMRAP performance is what the app uses to decide whether to bump your training max later.

If any lift in the workout is a bodyweight component (chin-ups, pull-ups, dips), a **body weight gate** asks you to confirm or enter your body weight for this workout before the form unlocks. The gate is keyed on the workout's date, not on today — so if you enter a body weight, then later open a different-dated workout (e.g., backfilling last week or logging a rescheduled session), the gate fires again for that date.

Submitting writes a `LiftRecord` per set. As soon as the first set is logged, the dashboard badge flips to **Completed**. Once every working set has a record, the page itself becomes read-only.

---

## Workout detail

**Route:** `/cycle/<n>/workout/<m>/detail`

A summary view with the workout's status badge, date, week number, total lifts, total sets, and an expandable list of planned lifts (warm-up plus work sets, with weights filled in from your current training max).

Actions available from here:

- **Manage Lifts** (`.../detail/manage-lifts`) — edit the lifts in the workout. The list lets you add, remove, or reorder lifts. From there you can:
  - **Pick** (`.../manage-lifts/pick?action=add|replace&replacing=<lift>`) — type-ahead search the built-in catalog of ~20 barbell, dumbbell, and bodyweight movements by name. Confirm to add to the workout or replace an existing slot.
  - **Edit** (`.../manage-lifts/edit/<lift>`) — change sets, reps, or intensity modifiers for a specific lift.
- **Start Logging** — shortcut to the logging page above. Hidden once the workout is completed or skipped.
- **Reschedule** — set a different date for this workout. The new date is treated as the effective date everywhere (dashboard cell, status calculation, etc.) and the original is shown in a "(rescheduled)" annotation.
- **Skip** — mark the workout skipped with a reason. Skipped workouts show the **⊘ Skipped** badge and stay in the cycle for the record. Hidden once the workout is completed.

There is also `/cycle/<n>/workout/<m>/detail/<lift>` — a per-lift drilldown showing your current training max, the training max history for that lift, and every set you've ever logged for it.

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

- **Browse Programs** — the built-in catalog (5/3/1, BBB and other 5/3/1 variants, etc.). The card for your active program is highlighted. Switching programs opens a confirmation dialog that warns about cycle reset implications.
- **My Programs** — custom programs you have authored. The editor lets you define week-by-week percentage and rep schemes, save the program, and (separately) switch the active program to it.

---

## Glossary

- **1RM (one-rep max)** — the heaviest weight you can lift once for a given exercise. The onboarding flow can estimate it from a heavier-rep set using the [Brzycki formula](https://en.wikipedia.org/wiki/One-repetition_maximum#Brzycki).
- **Training max (TM)** — a working number, typically 85–90 % of your 1RM, that every percentage in the program is calculated from. Lower than your true 1RM by design.
- **AMRAP** — "as many reps as possible." The last set of certain lifts is performed to technical failure; the rep count you hit is what drives training-max adjustments.
- **Deload** — a planned lighter week to manage fatigue. Commonly scheduled every fourth week in strength programming generally, but **none of the built-in programs currently schedules one** — deload is a documented non-goal for v1.0 (see [PRD.md](PRD.md)), and no shipped program marks a week as a deload.
- **PR (personal record)** — your highest logged value for a given lift, set count, or training max.
- **Bodyweight component** — an exercise where your body weight is part of the load (chin-ups, pull-ups, dips). Logging a workout that includes one triggers the body-weight gate.
- **Brzycki formula** — `1RM ≈ weight × 36 / (37 − reps)`. Reasonably accurate for sets of 1–10 reps.
