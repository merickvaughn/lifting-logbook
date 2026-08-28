# Proposal: Workout Rest Timer

**Status:** `draft`
**Date:** 2026-08-28
**Issue:** [#958](https://github.com/merickvaughn/lifting-logbook/issues/958)

---

## Problem

Rest between sets is a programmed variable, not an incidental gap. On a 5/3/1-style working set
the difference between 90 seconds and 4 minutes of recovery changes what the next set can carry —
so a lifter running the program as written has to time it. Today the app gives them nothing: a
repo-wide scan of `apps/*` and `packages/*` for `setInterval`, `requestAnimationFrame`,
`AudioContext`, `navigator.vibrate`, `wakeLock`, and `Notification` returns **zero** occurrences
outside of a Clerk-token promise race (`apps/web/lib/with-timeout.ts:29`) and an LLM abort
deadline (`apps/api/src/adapters/llm/agent-tools.ts:355`). "Rest" is not a domain concept anywhere
in `packages/types`.

The practical consequence is that the app owns the *plan* and the *log* but abandons the lifter
for the part of the session that actually takes the most wall-clock time. They leave the app,
open the phone's stopwatch, and come back — which is exactly when a set gets mis-logged or
skipped, and exactly the context-switch the workout-detail page exists to prevent.

A phone clock also can't know the plan. It can't tell a warm-up rest from a working-set rest,
can't shorten rest on a deload week, and can't advance itself when the set is done — all of which
the app already has the data to do.

## Proposed Solution

A rest timer that reads the workout's own plan, driven by durations the lifter configures once.

**Two surfaces**, both derived from the same state:

1. **A timer page** at `/cycle/[cycleNum]/workout/[workoutNum]/timer`, with two tabs — a live
   dial (phase label, countdown, current lift, the full session queue) and a settings panel
   (presets, per-duration steppers, per-lift overrides, deload defaults, alert behavior).
2. **A docked mini-timer on the workout-detail page**, so a session can be run without leaving
   the lift list. It expands to a full-screen sheet, and each set row gains a ▶ to start the
   timer from that set. The active set is highlighted and finished sets are checked off as the
   queue advances.

**The queue is built from data, not scraped from the DOM.** `computePlannedSets`
(`apps/web/lib/workoutPlan.ts:101`) already produces a typed `PlannedSet[]` per lift with
`type: 'warmup' | 'work'`, `setLabel`, `weight`, and `reps` — everything the queue needs. Each set
expands to up to three phases: an optional `prep` countdown ("get in position"), the `set` itself,
and a `rest` phase whose duration depends on whether the set was a warm-up or a working set. The
trailing rest is dropped, so a session ends on a set.

**Durations resolve by precedence** — per-lift override, then deload context, then the active
preset — which is what lets one setting screen serve every workout without per-session fiddling.

**The timer runs on the clock, not on the screen.** Elapsed time is always computed as a
`Date.now()` delta (`(pausedAt ?? now) - startedAt - pausedMs`), never accumulated from ticks. The
200 ms interval exists only to re-render. This is what makes the design's promise — lock the phone
mid-rest and it keeps counting — actually true, rather than true only while the tab is foreground
and unthrottled.

**Settings persist client-side, deliberately.** A single versioned `localStorage` key
(`ll.timer.v1`) holds presets, overrides, behavior flags, and the in-flight run, behind one typed
accessor module. That is what makes the two surfaces share state with no server round-trip, and it
keeps this proposal to zero schema changes and zero new endpoints. Server-side sync is a named
follow-up, not an oversight — see Open Questions.

The pure parts — queue construction, duration resolution, clock math — live in `packages/core`,
which is where infrastructure-free domain logic belongs and which makes them unit-testable
without jsdom. Only the browser-bound parts (interval, wake lock, WebAudio, vibration,
`localStorage`) live in `apps/web`.

## Acceptance Criteria

- [ ] `/cycle/[cycleNum]/workout/[workoutNum]/timer` renders a live dial and a settings panel as
      two tabs, reachable from the workout-detail page
- [ ] The session queue is built from `computePlannedSets` output — `prep → set → rest` per set,
      warm-ups optionally skipped, trailing rest dropped
- [ ] Duration resolution honours precedence: per-lift override > deload context > active preset
- [ ] Three presets ship (Standard / Heavy day / Light day) and each duration is individually
      editable via stepper or direct entry
- [ ] The workout-detail page gains a "Start timed workout" action, a per-set ▶, active/done set
      row states, a docked mini-timer, and an expandable full-screen sheet
- [ ] A run started on one surface is picked up by the other; a persisted run is restored **only**
      for the workout it belongs to
- [ ] Elapsed time is computed from wall-clock deltas — **proven by a test that advances the clock
      without firing the interval**, not by inspection
- [ ] Phase end fires the configured alert (beep and/or vibration), honouring Silent; the optional
      3-2-1 countdown fires only before a set, never before rest
- [ ] Rest can either auto-advance at zero or count up past it, per the `countUp` setting
- [ ] Screen wake lock is acquired while a run is active when enabled, **and re-acquired on
      `visibilitychange`** — the browser drops it when the page hides
- [ ] Every browser API (`localStorage`, `wakeLock`, `AudioContext`, `vibrate`) is feature-detected
      and fails open; a corrupt or absent settings blob falls back to defaults
- [ ] New colors are theme tokens in `globals.css`, defined for **both** `navy` and `iron` — no
      hardcoded hex
- [ ] The expanded sheet is a proper dialog: `role="dialog"`, `aria-modal`, focus moved in and
      restored, Escape to close, focus trapped
- [ ] The countdown does not spam assistive tech — `role="timer"` on the number, with a separate
      polite live region announcing phase transitions only
- [ ] `prefers-reduced-motion: reduce` disables the dial and dock transitions
- [ ] Playwright covers start → dock appears → expand sheet → pause/resume → skip

## Out of Scope

- **Activation phase.** The mockup models a pre-session activation block ("Hip Airplane"), but
  `PlannedSet.type` is only `'warmup' | 'work'` — no activation concept exists in the domain, so a
  settings row for it would control nothing. Follow-up.
- **Accessory-lift rest context.** Needs per-lift `LiftClassification`, which the detail page
  cannot cheaply obtain: `fetchLiftCatalog` returns `string[]`, and `fetchLiftMetadata` is one call
  per lift and exposes `foundational`, not `classification`. Per-lift overrides cover the same need
  today. Follow-up.
- **Server-side settings sync.** See Open Questions.
- **App-wide dark mode.** The mockup ships a full dark palette and an Auto/Light/Dark control, but
  `apps/web`'s `[data-theme]` mechanism switches *accent* themes (`navy`, `iron`), not light/dark.
  Wiring the control up would mean building app-wide theming inside a timer PR. Separate proposal.
- **Timing the logging flow.** This proposal covers the plan (detail) and timer surfaces. Driving
  the timer from `WorkoutLogger`'s set submission is a natural next step, not this one.
- **Background notifications.** No Service Worker, no push. The timer alerts while the page is
  alive; the wake lock is what keeps it alive.
- **Recording actual rest taken.** The timer does not write to `LiftRecord`. Persisting real rest
  durations as training data is a separate feature with a schema change behind it.

## Open Questions

- **When does settings sync move server-side?** Client-only is the right v1 — it keeps this to
  zero endpoints and zero migration. But settings are per-browser: a lifter who trains with a
  phone and reviews on a laptop configures twice, and clearing site data resets them. The accessor
  module is deliberately the single seam so the swap is one file. Open question is whether it rides
  a `UserSettings` extension (five sections exist already in
  `apps/web/app/(authed)/settings/sections.ts`) or its own resource.
- **Should timer settings also appear under `/settings`?** The mockup puts them on a tab of the
  workout-scoped timer page, which is where the lifter is when they want to change a duration —
  but they're *global* settings living on a workout URL, which is a discoverability oddity. A
  sixth `settings/sections.ts` entry pointing at the same panel is cheap; deferred pending use.
- **Is 200 ms the right tick?** It is what the mockup uses and it is imperceptibly smooth for a
  seconds-resolution display. If battery measurement says otherwise, the wall-clock design means
  the interval can be lengthened to 1 s with no correctness change — only the dial's smoothness
  moves.
- **Should the 3-2-1 countdown also precede rest ending?** The mockup deliberately fires it only
  before a *set* ends, on the theory that rest ending is less time-critical. Worth revisiting once
  someone has actually trained with it.

## References

- [Web Locks / Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/) — W3C spec; §3.3
  documents that a lock is released when the document becomes hidden, which is why re-acquisition
  on `visibilitychange` is an acceptance criterion
- [MDN — Web Audio API `OscillatorNode`](https://developer.mozilla.org/en-US/docs/Web/API/OscillatorNode)
  — the beep primitive, and the user-gesture requirement for resuming an `AudioContext`
- [MDN — `Navigator.vibrate()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)
  — vibration pattern support and its desktop no-op behavior
- [WAI-ARIA 1.2 — `timer` role](https://www.w3.org/TR/wai-aria-1.2/#timer) — defines `timer` as a
  live region with an implicit `aria-live="off"`, which is why the ticking number does not
  announce
- [WAI-ARIA Authoring Practices — Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
  — focus management and Escape behavior required of the expanded sheet
- [ADR-004 — Multi Data Store Adapters](../adr/ADR-004-multi-data-store-adapters.md) — the
  `packages/core` infrastructure-free boundary this feature's queue math sits behind
