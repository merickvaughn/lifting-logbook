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
## Amendment 3 — the activation phase, and what the spec's `activation` column means (2026-08-31, [#960](https://github.com/merickvaughn/lifting-logbook/issues/960))

This extends the decision above rather than reopening it — the split it records (plan data
server-side, timer configuration client-side) is what settles where each half of an activation block
lives.

### The premise #960 inherited was wrong

#958 scoped the mockup's activation block out on the grounds that "no activation concept exists in
the domain." In fact `LiftingProgramSpecResponse.activation: string` already existed, DB-backed
(`custom_program_spec.activation`, shipped in migration `20260515151721_add_programs_management`),
mapped by `toLiftingProgramSpecResponse`, importable via the CSV `Activation` column, and already
fetched by both timer surfaces. Nothing in `apps/web` read it, which is why the gap went unnoticed.

Its documented meaning is an **exercise name**: `rpt_program_spec.schema.json` describes it as
"Activation exercise name", it maps to the Sheets-era `"Activ. Ex."` column in `LIFT_SPEC_HEADERS`
(archived with the rest of the Sheets grid code in #979),
and the design doc's own example value is `"leg press"`.

### Decision

**An activation movement is program-spec data.** It varies per `(program, week, lift)` and is already
stored and served, so this needed no migration, no new endpoint, and no `packages/types` change. The
queue emits one `activation` phase before each lift's first *timed* set.

**Its duration stays client-side**, as a sixth `TimerDurationField` in `ll.timer.v1`, resolved through
the unchanged override → deload → accessory → preset chain of Amendment 1 — unchanged in the sense
that this field needed no new rung, not that the chain is still three rungs long. (In practice
`DEFAULT_ACCESSORY_DURATIONS` sets no `activation`, so an accessory's activation falls through to the
preset unless the lifter sets one.) That split falls straight out of the decision above:
this ADR constrains timer settings and run state, not the plan, which was always server-side.

**The activation attaches to `TimerLiftPlan`, not to a set** — mirroring the mockup, where `kind` is a
property of a lift. That is what keeps `PlannedSet` and `computePlannedSets` untouched: a `PlannedSet`
is TM-derived arithmetic (`weight: number`, `reps: number`), and an unweighted "8 each side" movement
does not fit it. The phase carries its own synthetic set naming the movement rather than borrowing the
one it precedes, so the dial does not announce "Warm-up 1 · 5 × 135 lbs" during hip airplanes.

**The column is read, not rewritten.** `PRESET_BASE_SPECS` and the program editor's default row store
a movement *classification* there (`'compound'` / `'isolation'`) instead of a name, so a naive read
would put "Activation · compound" in front of every lift of every built-in program. Rather than
rewrite those literals — `presets/index.test.ts` asserts on them, and they are the only classification
data the repo has — `activationExercise` (`packages/core/src/timer/activation.ts`) treats a closed set
of legacy values as "no activation". Each member traces to a shipped literal (`''`, `'compound'`,
`'isolation'`, `'none'`); `'main'` / `'standard'` / `'accessory'` are deliberately excluded because
they occur only in unrelated API test fixtures.

### Alternatives considered

- **A client-only timer setting** — a movement name and duration configured once in Timer Settings.
  Rejected: it duplicates a field that already exists, and it cannot vary by program or week, which is
  exactly what a spec-driven activation is for.
- **A new per-workout annotation resource** — a Prisma model, endpoints, a repository and a UI.
  Rejected on the same cost grounds as Option 1 above: four layers and a migration for a countdown
  ring, when the column is already on the wire.
- **Rewriting `PRESET_BASE_SPECS` to blank the legacy values.** Rejected: it discards the only
  classification data in the repo and changes what `GET /programs/:program/spec` returns, for no gain
  a read-side predicate does not already deliver.

### Consequences

- The dial now paints **five** phases, so `--color-activation` joins the guarded set (navy `#8e44ad`,
  iron `#7c3aed`) and `DIAL_PHASES` grows. That guard reads the *stylesheet*, so it cannot see whether
  `TimerDial.tsx` ever applies the class — and that chain ends in `styles.set` as its fallthrough, so
  an unbranched phase paints accent-coloured and passes. `TimerDial.test.tsx` closes that half.
- `TimerPresetDurations` is a total `Record`, so adding the field broke every preset literal at
  compile time — the intended failure mode. A persisted blob written before this change has no
  `activation` duration; `normalizeTimerSettings` fills it from the shipped preset rather than leaving
  a hole that would render `NaN`.
- The per-set ▶ had to learn to skip the activation: it shares the `setIndex` of the lift's first
  timed set, exactly as a `prep` does, so a plain match would have started "Start timer at Squat
  Warm-up 1" on a hip-airplane countdown.
- **An in-flight run had to be versioned, not just the settings.** `TimerRunState.idx` is a bare
  index into a queue whose shape this change alters, so a run persisted before it resumed on the
  activation that now precedes the set it was recorded against — with `startedAt` carried over, so
  elapsed time measured against a 60 s set was applied to a 240 s rest. The re-anchor effect cannot
  catch this: it compares against the *previous render's* queue, which on a fresh mount is already
  the new shape, so it re-finds and then cements the displaced phase. `TIMER_RUN_SHAPE` in
  `timerSettings.ts` stamps the blob and drops a run written under a different value. A run is
  minutes of ephemeral position; a silently wrong countdown is indistinguishable from a working one.
- **`TIMER_RUN_SHAPE` and Amendment 2's `classifications` compose rather than conflict**, though
  both landed in the same release and both concern the run blob. Amendment 2's leniency is about one
  *field*: a run missing or carrying a malformed `classifications` still restores, degrading to `{}`
  rather than being rejected. This stamp is about the *index*, which is not a field the run can
  self-describe — a stale `idx` is structurally unsafe no matter how well-formed the rest of the
  object is. A run stamped for this queue shape but missing `classifications` still restores exactly
  as Amendment 2 intends; only a run predating the shape change is dropped, and it is dropped for a
  reason Amendment 2 never spoke to. Amendment 2's three degradation tests were given the stamp so
  they keep exercising `normalizeClassifications` instead of being rejected earlier for an unrelated
  reason.
- **Two exhaustiveness mechanisms were added, because this change is the argument for them.**
  `TimerPhaseKind` is now derived from a `TIMER_PHASE_KINDS` array so tests and the colour guard can
  iterate it, and `TIMER_DURATION_FIELDS` carries a compile-time completeness assertion. Both exist
  because the failure they prevent is silent: three of the places that switch on a phase kind end in
  a fallthrough, and a duration field missing from `TIMER_DURATION_FIELDS` is simply never read back
  out of storage, so the lifter's saved value reverts to the default on every load.
- **This closes a latent option Amendment 1 declined to take anyway.** `activation` holds *almost*
  the `LiftClassification` data #961 needed — the built-in presets fill it with
  `'compound'`/`'isolation'` — so squatting on the column was a possibility there. Amendment 1
  instead sourced classification from `LIFT_CATALOG`, which is the better answer and leaves this one
  free: `activation` means an exercise name, and the two features do not contend for the field. What
  remains untidy is the column's *stored* contents, which are a classification in every shipped
  preset. Disambiguating that — leaving `activation` as the name, and surfacing it in the program
  editor so a lifter can set one at all — is filed as a follow-up; until then only an imported
  `Activ. Ex.` column or a hand-authored custom program can name a movement.

### Verification

- `packages/core/tests/core/timer/activation.test.ts` — calibrates the predicate in both directions,
  from **two** corpora read live, each with a non-empty assertion in front of it so a reshape fails
  the test rather than passing over an empty list. The second corpus was the correction: the first
  cut calibrated against `PRESET_BASE_SPECS` alone, and the built-in presets carry only
  classification values — so it never saw `N/A`, which is what `tests/fixtures/rpt_program_spec.csv`
  (a real exported sheet) uses for "this lift has no drill". Import is one of only two ways to name
  an activation today, so that was the corpus that mattered most and the one left out; the fixture is
  also two-sided, carrying markers and genuine names in the same column, and the test asserts *both*
  halves are non-empty rather than just the corpus overall.
- `packages/core/tests/core/timer/queue.test.ts` — one phase per lift (not per set), none without a
  movement, none at duration zero, `setIndex` alignment under `skipWarmups`, and a repeated lift name
  getting one activation per occurrence.
- `apps/web/components/timer/TimerDial.test.tsx` — every phase kind resolves to a *distinct* class.
- `scripts/check-timer-phase-colors.mjs` — recalibrated at five phases: passes on the current
  definitions, and fails naming `prep and activation` when `--color-activation` is set to iron's
  amber. It now also cross-checks `DIAL_PHASES` against `TIMER_PHASE_KINDS` read from
  `types.ts`, so a phase kind added in core without a colour is a CI failure rather than a phase
  nothing checks — verified by adding a sixth kind and watching it fail.
- `apps/web/lib/__tests__/timerSettings.test.ts` — a pre-`TIMER_RUN_SHAPE` blob is dropped, a
  stamped one round-trips, and a settings write carries the stamp forward (without which changing a
  duration on the Settings tab would silently end the session).

---

## Amendment 4 — Phase identity is positional, and the run persists it (2026-09-04)

**Closes:** [#980](https://github.com/merickvaughn/lifting-logbook/issues/980), and through it
[#970](https://github.com/merickvaughn/lifting-logbook/issues/970),
[#971](https://github.com/merickvaughn/lifting-logbook/issues/971),
[#972](https://github.com/merickvaughn/lifting-logbook/issues/972)

### Context

Three filed issues and one latent defect turned out to share a cause: a phase in the session queue
had no shape-stable identity, so every piece of machinery that needed one improvised its own.
`buildTimerQueue` detected a lift boundary by comparing `liftIndex` against the previous set's,
relying on an unstated "flattened sets are grouped by lift" invariant (#970). `WorkoutTimerProvider`
keyed its per-set ▶ map on `(lift, setLabel)` and `useWorkoutTimer` re-anchored a live run on
`(kind, lift, setLabel)`, so a lift that appears twice in one workout — legitimate, since the program
editor keys an instance by position — resolved to its first occurrence on both surfaces (#971). When a
rebuild removed the phase the run was on (a duration set to `0:00`, `skipWarmups` toggled mid-warm-up),
the re-anchor ended the session and cleared the persisted run instead of moving on (#972).

The latent defect was in the re-anchor's premise. It compared the new queue against the *previous
render's* queue, but a fresh mount builds its first queue from the default settings and only then
swaps in the persisted ones — so a restored run's `idx` was read against a queue of the wrong shape.
With `skipWarmups` on (or `prep` / `activation` at zero) every reload and every detail → timer
navigation mis-anchored or ended the run: the exact flow the Decision section promises survives.

### Decision

1. **A lift's identity within a workout is its position.** `TimerPhase` carries `liftIndex` (the
   lift's position in the plan, matching the program editor's own instance key) and `setOrdinal`
   (the set's position in its lift's *full* set list, warm-ups included, so it does not renumber when
   `skipWarmups` toggles; `-1` for an activation, which precedes every set of its lift).
   `toTimerLiftPlans` no longer drops a lift with no planned sets, so the plan, the detail page's
   `liftDetails` and `workout.lifts` are index-aligned by construction — the earlier rationale for
   dropping was wrong: `flattenSets` emits nothing for an empty lift, so nothing is queued either way.
2. **The shape-stable key is `(liftIndex, setOrdinal, kind)`, carrying the lift name as a sanity
   check** — `TimerPhaseKey`, with `comparePhaseKeys` giving it the total order the queue is emitted
   in (activation < prep < set < rest; the name plays no part in the order). `(kind, setIndex)` was
   rejected because `setIndex` addresses the timed set list and renumbers under precisely the change
   most likely to rebuild the queue; `(lift, setLabel)` was rejected because it cannot tell two
   occurrences apart and gives no forward order to search in. Position alone was also rejected: it
   would alias silently if the plan were reordered under a live run (a lift inserted or removed
   ahead of the current one in the program editor), so a positional hit whose name differs is
   treated as "this is not the plan the run was anchored in" and the session ends rather than
   resuming on someone else's set.
3. **The run persists its anchor.** `TimerRunState.on` holds the key; `idx` is a cache re-derived
   from it by `reanchorIndex` every time the queue is (re)built — and the *displayed* phase is read
   through that same resolution, never through the cached `idx`, so a rebuild cannot paint, announce
   or tick against a phase the run is not on for the one render before the cache catches up. The
   previous-queue comparison is gone, which is what closes the mount-time defect: the anchor is
   resolved against the queue as it is, never against what a prior render happened to build.
4. **Removal advances; only emptiness ends.** When the anchored phase is gone, the run starts fresh
   on the nearest surviving phase after it in key order — fresh in clock and bonus, but not in pause
   state: a paused run stays paused, because the lifter's explicit pause outranks the advance (the
   Settings tab that removed the phase is one tap from the dial, and a set must not run down while
   they are still on it). The session ends only when nothing survives after the anchor.
5. **`TIMER_RUN_SHAPE` is 3**, and its bump rule now also covers "changes what a run needs in order to
   be re-anchored". A shape-2 run has no `on`, and reconstructing one from `queue[idx]` at load time
   would reintroduce the very ambiguity item 3 removes, so such runs are dropped — the documented
   policy, costing minutes of ephemeral position once per browser at deploy.
6. `buildTimerQueue` opens a lift's activation on `firstOfLift`, a flag `flattenSets` sets on the
   first surviving set of each lift where the loop already knows it — no grouping invariant, no
   builder state.

Related, already landed: the three per-kind fallthroughs Amendment 3 named were closed by exhaustive
`Record<TimerPhaseKind, …>` lookups in
[#977](https://github.com/merickvaughn/lifting-logbook/issues/977); `KIND_RANK` in `anchor.ts` is
now a third such table (its presence is compiler-enforced, its values checked by `anchor.test.ts`).

### Consequences

- The per-set ▶, the auto-expand, the re-anchor and the persisted run all key on position, so a
  repeated lift behaves as two lifts everywhere — and the lift list's React keys are positional too,
  which also removes the duplicate-key warning a repeated lift produced. Panel ids are prefixed with
  `useId()` so a second list on a page cannot collide.
- The index alignment between the page's `liftDetails` and the plan handed to the timer is now
  load-bearing across two routes and a persisted artifact; `detail/page.test.tsx` pins it (every
  lift, in order, including one with no training max) until
  [#984](https://github.com/merickvaughn/lifting-logbook/issues/984)'s shared loader makes it
  structural. That loader partially revisits Amendment 2's rejection of "a shared layer above both
  routes" for *plan data* only; classification pinning stays, because the two routes still mount
  the hook independently.
- `TimerSettingsPanel`'s per-lift override list hides lifts with no sets (`hasTimedSets`, the one
  predicate for "this plan entry has nothing to time") and then dedupes by name, in that order, so an
  empty first occurrence cannot shadow a timed later one.
- Out of scope, and now cheap: cross-tab sync
  ([#995](https://github.com/merickvaughn/lifting-logbook/issues/995)). With a persisted key, a
  `storage`-event re-hydrate no longer needs to re-derive position from a queue index.

### Verification

- `packages/core/tests/core/timer/anchor.test.ts` — key ordering matches the emitted queue and every
  kind in `TIMER_PHASE_KINDS` ranks distinctly; the re-anchor table (prep → 0:00 lands on the set; a
  skipped-away warm-up lands on the first work set's prep, never back on the activation; activation →
  0:00 lands on the first prep; a vanished lift lands on the next lift; `-1` only when nothing
  survives; a repeated lift re-anchors onto the right occurrence; a plan reordered under the run ends
  rather than aliasing); the storage guard accepts ordinal `-1` and rejects malformed keys.
- `packages/core/tests/core/timer/queue.test.ts` — `liftIndex` / `setOrdinal` on every phase with the
  activation at `-1`, `setOrdinal` stable under `skipWarmups` while `setIndex` renumbers,
  `firstOfLift` under both `skipWarmups` values, and the repeated-lift activation test now asserting
  distinct lift indexes.
- `apps/web/lib/__tests__/useWorkoutTimer.test.tsx` — the removed-phase case re-expressed as
  "advances to the first surviving phase"; a prep and an activation set to `0:00` while live are
  skipped; a paused run stays paused through that skip; "ends only when nothing survives"; the second
  occurrence of a repeated lift stays anchored through a rebuild; and the mount-time case: a run
  persisted under `skipWarmups` restores onto the same phase — which failed on the previous-queue
  comparison.
- `…/timer/WorkoutTimerView.test.tsx` — a repeated lift whose first occurrence has no sets still gets
  exactly one override row; `…/detail/page.test.tsx` — every lift reaches the timer in plan order,
  an empty one included.
- `…/detail/CollapsibleLiftList.timer.test.tsx` — with the same lift twice, the ▶ inside the second
  item marks the row inside the second item.
- `apps/web/lib/__tests__/timerSettings.test.ts` — a run with no anchor, a malformed one, or one of
  an unknown kind is rejected; the shape-2 drop is covered by the existing older-stamp cases.

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
