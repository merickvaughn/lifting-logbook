# ADR-035: The Rest Timer Keeps Its State Client-Side, on the Wall Clock

**Status:** Accepted
**Date:** 2026-08-28
**Closes:** [#958](https://github.com/merickvaughn/lifting-logbook/issues/958)
**Related:** [ADR-004](ADR-004-multi-data-store-adapters.md) (the `packages/core` infrastructure-free boundary)

---

## Context

The rest timer ([#958](https://github.com/merickvaughn/lifting-logbook/issues/958)) is the first
feature in this repo that needs a running clock, an audible alert, haptics, and a screen wake lock.
Before it, a repo-wide scan of `apps/*` and `packages/*` for `setInterval`,
`requestAnimationFrame`, `AudioContext`, `navigator.vibrate`, `wakeLock`, and `Notification`
returned **zero** occurrences outside a Clerk-token promise race
(`apps/web/lib/with-timeout.ts`) and an LLM abort deadline
(`apps/api/src/adapters/llm/agent-tools.ts`). There was no house pattern to inherit, so this
feature establishes one.

Two decisions had no obvious default and would be expensive to reverse silently:

1. **Where timer settings live.** Presets, per-lift overrides, deload durations and alert behavior
   are user preferences. `apps/api` already has a `UserSettings` resource with five sections, so
   putting them there was the "consistent" choice — at the cost of a Prisma migration, new
   endpoints, a repository, and a core service, for a feature whose value is entirely in the
   browser.
2. **How elapsed time is computed.** The obvious implementation accumulates a counter on each
   interval tick. That is wrong in a way that only shows up in the exact situation the feature
   exists for: a lifter locks the phone during a four-minute rest, the browser throttles or stops
   the interval, and the timer under-reports by minutes.

## Decision

**Timer state is client-side, in one versioned `localStorage` key (`ll.timer.v1`), behind a single
accessor module** — `apps/web/lib/timerSettings.ts`. That key holds both the settings and the
in-flight run, which is what lets the timer page and the workout-detail dock share a live session
with no server round-trip: navigate between them and the countdown continues.

The accessor is deliberately the *only* seam that touches storage, so moving settings server-side
later is a one-file change rather than a refactor of every call site. Storage failures fail open
silently and do **not** route through `logClientError`, matching the rationale already documented
in `workoutDraftStorage.ts`: that helper is scoped to API mutation failures and beacons every call,
so a quota error or a disabled-storage `SecurityError` would spam telemetry for a benign browser
condition.

**A persisted run carries the `{program, cycleNum, workoutNum}` it belongs to and is restored only
for a matching workout**, so a session abandoned on Tuesday cannot surface the dock on Thursday.

**Elapsed time is always a wall-clock subtraction** — `(pausedAt ?? now) - startedAt - pausedMs` —
never a sum of ticks. The 200 ms interval exists only to trigger a re-render. `now` is a parameter
to every clock function in `packages/core/src/timer/clock.ts` rather than a `Date.now()` call
inside them, which keeps the module pure and lets a test advance the clock *without* firing the
interval — the exact condition a throttled background tab creates.

**The pure half lives in `packages/core/src/timer/`** (queue construction, duration resolution,
clock math) and the browser half in `apps/web` (interval, wake lock, WebAudio, vibration, storage).
Core takes its own `TimerLiftPlan` input type rather than importing `PlannedSet` from `apps/web`,
so the dependency arrow keeps pointing inward per [ADR-004](ADR-004-multi-data-store-adapters.md).

**The dial's four phase colors are guarded, not assumed.** The ring paints one of
set / rest / prep / overrun, so any two resolving to the same value inside a theme silently stops
the ring carrying information. Rest originally used `--color-success`, which is correct under
`navy` (accent `#3498db` vs. success `#27ae60`) and collapses under `iron`, where the accent *is*
green — both resolved to `#22c55e`. `--color-rest` exists to break that tie, and
`scripts/check-timer-phase-colors.mjs` fails CI if any theme reintroduces a collision. Nothing else
catches this: both are valid tokens, the page renders, and every test passes.

Two supporting conventions this establishes for future browser-API work:

- **Every browser API is feature-detected and fails open.** `AudioContext` (including the
  `webkit`-prefixed form), `navigator.vibrate`, `wakeLock` and `localStorage` are each guarded; a
  browser that refuses one still gets a working countdown.
- **The wake lock is re-acquired on `visibilitychange`.** Per the
  [Screen Wake Lock spec §3.3](https://www.w3.org/TR/screen-wake-lock/), the lock is released when
  the document becomes hidden and is *not* restored when it becomes visible again. Acquiring once
  at session start would silently stop working after the first tab switch.

## Alternatives Considered

### Option 1: Server-side settings from the start

Add a sixth `UserSettings` section, with a migration, endpoints, repository and core service.
Settings would sync across devices and survive a cache clear.

Rejected for v1 on cost, not on principle. It is roughly three to four times the work, touches
every layer of the hexagon, and adds a migration to a feature that otherwise has zero schema
surface and reverts by deleting a route. The accessor seam above makes the later move cheap, and
the follow-up is tracked rather than assumed. The real cost accepted is that settings are
per-browser — a lifter who trains on a phone and reviews on a laptop configures twice.

### Option 2: Accumulate elapsed time per tick

`elapsed += TICK_MS` on each interval firing. Simpler to read, and correct while the tab is
foregrounded.

Rejected because it is wrong precisely when the feature matters. Browsers throttle background
timers aggressively (and stop them when the screen locks), so the counter drifts low by however
long the phone was away — turning a four-minute rest into an under-reported one with no signal
that anything went wrong. The wall-clock form is not meaningfully harder and cannot drift.

### Option 3: Persist the run in memory only, not in storage

Keep the queue position in React state, so a reload ends the session.

Rejected because the two surfaces (timer page, detail-page dock) are separate routes: a full
navigation between them would drop the session, which is exactly the "leave the app and lose your
place" problem the feature exists to remove. Persisting also survives an accidental reload
mid-workout.

### Option 4: A Service Worker for background notifications

Would let the timer alert after the tab is closed.

Rejected as out of scope: it adds a new deployment artifact and a permission prompt, and the wake
lock already covers the "screen off, app still open" case that a lifter actually hits.

## Consequences

### Positive

- Zero schema change, zero new endpoints; rollback is a revert.
- Correct timekeeping through a locked phone or a throttled tab, provable by a test that advances
  the clock without firing the interval.
- The queue and duration math are pure functions unit-tested without jsdom, and reusable by
  `apps/mobile` later.
- One documented seam (`timerSettings.ts`) for the eventual server-side move.

### Negative / Risks

- Settings do not sync across devices and are lost when site data is cleared. Tracked as a
  follow-up; the accessor is the mitigation.
- Two open tabs on the same workout each hold their own run and will write over each other's
  persisted state. No cross-tab `storage`-event sync is implemented; last write wins.
- `AudioContext` must be created inside a user gesture, so the Start button plays a short chime to
  unlock it. A session advanced entirely by auto-advance from a page the user never clicked would
  have no audio.

## Verification

- `packages/core/tests/core/timer/clock.test.ts` — advances the clock with `setSystemTime` and no
  timer firing, asserting the countdown is still correct; covers pause/resume accounting and
  overrun.
- `apps/web/lib/__tests__/useWorkoutTimer.test.tsx` — the same wall-clock property at the hook
  level, plus one-alert-per-phase, wake-lock acquisition, and run restore/reject by workout key.
- `apps/web/lib/__tests__/timerSettings.test.ts` — corrupt JSON, a throwing `getItem`/`setItem`,
  and every malformed-run shape degrade to defaults rather than throwing.
- `apps/web/e2e/timer.spec.ts` — start, dock, expand, pause/resume, Escape, end, and a reload that
  picks the run back up. This suite is also what caught the hydration mismatch described above: the
  server rendered `40:00 estimated` and the client `46:00`, because a `useState` initializer was
  reading `localStorage` during the first client render.
- `scripts/check-timer-phase-colors.mjs` — fails CI if any theme paints two dial phases the same
  color, or omits one. Calibrated against both references: it passes on the current `navy` + `iron`
  definitions, and fails on the known-bad state (`iron` rest reverted to `--color-success`) naming
  the exact colliding pair. It asserts at least one theme block was found, so an extraction that
  silently matched nothing reports a failure rather than a vacuous pass.

## Amendment 1 — the accessory rung, and where classification comes from (2026-08-29, [#961](https://github.com/merickvaughn/lifting-logbook/issues/961))

The shipped chain was **override → deload → preset**. It is now **override → deload → accessory →
preset**: a lift classified `accessory` takes its own shorter durations while `context.accessoryOn`
is set. Deload stays ahead of accessory — a deload week is the narrower, deliberately-entered
state — and each rung is still consulted per *field*, so the accessory context claiming `restWork`
leaves `restWarmup` to fall through.

The accessory rung was scoped out of #958 because the workout pages "cannot cheaply obtain
`LiftClassification`". **That premise was wrong, and the correction is the substance of this
amendment.** It rested on the two paths that go over the wire — `fetchLiftCatalog`, which returns
bare names, and `fetchLiftMetadata`, which is one call per lift and exposes `foundational` (a
per-user editable flag on `LiftMetadata`, defaulting to `false` for everyone) rather than a training
role. Neither is the cheap path, and the obvious remedy — widening `GET /programs/:program/lifts` to
return `{ name, classification }[]` — was rejected: it touches ~18 files across the API controller,
the client, three `string[]`-typed prop chains and the Playwright mock, **and neither the timer nor
the detail page calls that endpoint at all**, so it would still have required a new fetch on both.

Classification for built-in lifts was already sitting in `packages/core`, the same package
`resolveDuration` lives in: `DEFAULT_SLOT_MAP` maps program-spec slot names onto `LIFT_CATALOG`
ids, and every catalog entry carries a `classification`. `liftClassificationFor`
(`packages/core/src/catalog/classify.ts`) joins them into one eagerly-built `Map`, so the lookup is
local, synchronous, and free of new data. Only custom lifts need the network, and they are fetched
with the already-existing `fetchCustomLifts()` — bounded by `withTimeout` and caught, so neither a
failure nor a slow response takes down or holds up a timer someone is standing in the gym waiting
on.

**Three vocabularies reach that lookup, and seeding it from the slot map alone covers only one.**
This was caught in review, and it is the part worth remembering. A *built-in* program's spec `lift`
values are slot names, so `DEFAULT_SLOT_MAP`'s keys look like the complete vocabulary — but they are
only 8 of the catalog's 23 display names. A *custom* program's spec `lift` values come from
`ProgramEditor`'s exercise picker, which is built as `LIFT_CATALOG.map((l) => l.name)` and stores the
selected name verbatim, so it speaks catalog **names**; and a row pre-resolved through `liftOverrides`
circulates as a catalog **id**. Seeded from the slot map alone, 15 of 23 catalog names resolved to
`undefined` — 8 of them accessories, including Cable Curl and Lateral Raise, the two most obviously
accessory lifts in the catalog. The near misses are one character wide (`Cable Curls` is the slot
name, `Cable Curl` the catalog name), so the feature would have silently not fired for custom-program
users on exactly the lifts it exists for, with the settings panel reporting "Rest follows Standard".
The map is now seeded from all three vocabularies, slot-map aliases last so they win a collision.

The test that was supposed to cover this could not: it iterated `Object.keys(DEFAULT_SLOT_MAP)` —
the very map the lookup was seeded from — so it could only fail if a slot-map *value* named no
catalog id. A coverage assertion whose domain is the implementation's own input is not a coverage
assertion. The replacement iterates `LIFT_CATALOG` instead, and fails against the original seeding.

`accessoryOn` defaults to **on**, unlike `deloadOn`. Because `normalizeTimerSettings` merges a
persisted blob onto the defaults, an existing user's blob inherits it and their accessory durations
shorten on next load without being asked. That is the intended behavior change: four minutes between
cable curls is what the preset alone produces, and it is wrong. Note the shipped defaults shorten the
working-set countdown (60s → 45s) as well as rest, which is why the toggle reads "Shorter durations
for accessories" rather than "shorter rest" — a control that is on by default must not understate
what it changes.

`resolveDuration` gained a **required** fourth parameter rather than an optional one. An optional
parameter lets a call site opt out of the new rung by omission — no compile error, and durations
that still look plausible at runtime. `resolveDurationEntry` is a sibling that also reports which
rung won; the settings panel uses it to say what a lift actually follows, instead of the previous
hard-coded "Follows &lt;preset&gt;", which had been untrue for every lift whenever a deload week was on.

## Amendment 2 — pinning classification onto the run, so the two routes cannot disagree (2026-08-30, [#966](https://github.com/merickvaughn/lifting-logbook/issues/966))

Amendment 1 gave the timer page and the workout-detail dock each their own `fetchCustomLifts()` call
— bounded by `CUSTOM_LIFTS_TIMEOUT_MS` and caught, so neither a failure nor a slow response can take
down or hold up a timer someone is mid-session with. What it did not account for is that the two
calls **degrade independently**. The run itself is shared (`ll.timer.v1`, restored on both routes by
workout key, per the Decision above) — but the queue each route builds `phase.dur` from was not,
because each route was resolving `TimerLiftPlan.classification` fresh from its own fetch. A transient
failure or a slow response on one route and not the other meant the same in-flight rest could end at
4:00 on one surface and 1:30 on the other, for a custom lift classified an accessory.

Surfaced in review of [PR #964](https://github.com/merickvaughn/lifting-logbook/pull/964) (the
accessory rung Amendment 1 describes) and filed separately rather than fixed there, because the fix
is structural — it touches the run schema, not the code that PR changed.

**`TimerRunState` gained a required `classifications: Record<string, LiftClassification | null>`
field.** `snapshotClassifications` (`packages/core/src/timer/queue.ts`) captures each lift's resolved
classification, keyed by name, the moment a run transitions from no session to a live one; every
later call through `startAt` on that same run — advancing, jumping to a different set, resuming after
a backgrounded tab — carries the existing map forward rather than re-snapshotting it. On the read
side, `applyClassifications` overrides `useWorkoutTimer`'s `lifts` with the pinned map before building
the queue, so the queue a route builds reflects the run's pinned answer rather than that route's own
resolution, whenever a run is live. A lift the map has no entry for — new to the plan since the run
started, or a run persisted before this field existed — falls through to whatever the reapplying
route resolves on its own, exactly as every route did before this existed: pinning is additive, never
a reason for a lift to lose an opinion it already has.

Chosen over the two other options the issue weighed: resolving classification once in a shared
layer above both routes (cleanest, but a bigger structural change for a fetch that already succeeds
the overwhelming majority of the time) and documenting the divergence without fixing it (both pages
already carried a comment explaining the degradation; this closes the gap that comment described
instead of just naming it). Pinning also fixes a second case for free: a custom lift's classification
edited mid-session no longer changes an in-flight run's duration out from under the lifter, on either
route — the queue rebuild that follows a `lifts` prop change re-applies the same override.

**A pinned "no opinion" is stored as `null`, not `undefined` — this was wrong in the first draft of
this fix, and review of this PR caught it before merge.** The first draft snapshotted an unclassified
lift with `classification: undefined` and reasoned the resulting asymmetry — that `undefined`-valued
keys don't survive the `JSON.stringify` round trip through `localStorage`, so the pin quietly reverts
to "unpinned" the moment a *different* route reads it back — was an acceptable trade: "the mount
reporting no opinion is definitionally the degraded one, so a later mount's real answer winning over
an absent pin means a working fetch is never overridden by a failed one." That reasoning answered the
wrong question. The bug this issue exists to fix is not "which mount's answer is more correct" — it is
"do the two routes still disagree." Under the first draft they did: the pinning route (its own fetch
degraded) kept reading its own 240s locally, while any other route reading the round-tripped `{}` fell
back to its own resolution and read 90s — the identical "4:00 on one, 1:30 on the other" split from
the issue, just reached one hop later, and specifically whenever the *first* route to start a run was
the degraded one. `null` closes it: `snapshotClassifications` now writes an entry for every lift,
`null` in place of `undefined`, and `null` — unlike `undefined` — survives `JSON.stringify`. A stored
`null` is a real pin ("this lift has no opinion, and that is final"), distinct from an absent key ("no
pin was ever recorded"); `applyClassifications` reads the distinction via `hasOwnProperty` and maps a
stored `null` back to `undefined` on `TimerLiftPlan.classification` before handing the lift to
`buildTimerQueue`. `normalizeClassifications` now keeps a `null` value rather than treating it as
malformed, for the same reason.

**Two more review findings, both fixed in this PR rather than deferred, because both let the two
routes disagree in a case the fix's own tests didn't cover:**

- `useWorkoutTimer`'s `effectiveLifts` (the pinned override, what the queue is actually built from)
  was computed but never returned — `UseWorkoutTimerResult` still only exposed the queue and the raw
  `lifts` prop. The timer page's Settings tab resolves its own per-lift "Rest follows …" label and
  hints from `lift.classification` (`TimerSettingsPanel.tsx`), and was still reading the unpinned
  `lifts` prop — so during a live run whose pin disagreed with this route's own resolution, the
  Session queue and dial (built from `effectiveLifts`) and the Settings tab (built from raw `lifts`)
  could show different durations for the same lift, on the same page. `effectiveLifts` is now exposed
  on `UseWorkoutTimerResult`, and `WorkoutTimerView.tsx` passes it to `TimerSettingsPanel` instead of
  the raw prop.
- `startAt`'s dependency array closed over `run` (the whole object) where it only ever reads
  `run?.classifications`. `nudge` and `togglePause` both `commitRun({ ...run, ... })` — a new `run`
  reference on every ±30s or pause press — so `startAt`, and everything memoized on it
  (`startAtSet`, and `WorkoutTimerProvider`'s `rowState` context), got a new identity on every one of
  those presses. `WorkoutTimerProvider`'s own docblock states the point of keeping that context
  narrow and phase-boundary-stable is exactly to avoid re-rendering every set row in the lift list
  off the tick-driven dock — a property this PR's `startAt` change silently broke. Fixed by keying on
  `runClassifications` (already extracted, two lines above `startAt`, for the identical reason) instead
  of `run`.

**Classification map keys are lift names, which are arbitrary user input** (a custom lift's own name),
unlike every other `TimerRunState` field. `snapshotClassifications` and `normalizeClassifications`
(`packages/core/src/timer/settings.ts`, alongside `normalizeTimerSettings`) both build their output on
`Object.create(null)` rather than `{}`, so a lift literally named `"__proto__"` lands as its own entry
instead of being read through, or silently reassigning, `Object.prototype` — the same hazard class
`hasOwn`/`defineOwn` guard against for `overrides`/`presets` in the same file, addressed here at the
root by giving the accumulator no prototype to collide with. `applyClassifications`'s read is
additionally guarded with a borrowed `hasOwnProperty` rather than the `in` operator, so its own safety
does not depend on every future caller remembering to hand it a null-prototype map.

`isRunShape` (`apps/web/lib/timerSettings.ts`) deliberately does not validate `classifications` — a
run persisted before this field existed, or one with a malformed value, still passes the guard and
restores the rest of the run. `loadTimerRun` closes the gap immediately afterward, overwriting
whatever the guard let through with `normalizeClassifications`'s output — the same always-succeeds
contract `normalizeTimerSettings` already gives the settings half of this blob, extended to the run
half for the first time.

## References

- [Screen Wake Lock API](https://www.w3.org/TR/screen-wake-lock/) — W3C spec; §3.3 defines the
  release-on-hidden behavior that requires re-acquisition
- [MDN — `OscillatorNode`](https://developer.mozilla.org/en-US/docs/Web/API/OscillatorNode) — the
  beep primitive and the user-gesture requirement for resuming a suspended `AudioContext`
- [MDN — `Navigator.vibrate()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)
- [WAI-ARIA 1.2 — `timer` role](https://www.w3.org/TR/wai-aria-1.2/#timer) — a live region with an
  implicit `aria-live="off"`, which is why the ticking number does not announce
- [WAI-ARIA APG — Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) —
  focus management the expanded sheet implements
- [ADR-004](ADR-004-multi-data-store-adapters.md) — the infrastructure-free `packages/core` boundary
