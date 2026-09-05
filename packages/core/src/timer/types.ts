/**
 * Rest-timer domain types.
 *
 * Infrastructure-free by construction: nothing here touches `localStorage`,
 * `Date.now()`, or any browser API. The web layer owns persistence and the tick
 * loop; this package owns what a session *is* and how long each phase lasts.
 */

import type { LiftClassification } from '@lifting-logbook/types';

/**
 * The four things a timed session counts down, as a value.
 *
 * `activation` is the pre-lift movement drawn from the program spec's own
 * `activation` column — see {@link TimerLiftPlan.activation}.
 *
 * A runtime array rather than a bare type union so that tests and the
 * dial-colour CI guard can iterate it: a fifth kind enters every per-kind table
 * automatically. The places that *switch* on a kind — `TimerDial`'s class map,
 * the badge / sub-label copy in `apps/web/lib/timerLabels.ts`, and
 * `KIND_RANK` in `./anchor` (the order a set's phases are emitted in, which
 * re-anchoring depends on) — are exhaustive `Record<TimerPhaseKind, …>`
 * lookups, so a kind added here without an entry there is a compile error
 * rather than a phase that silently renders as a set (which is what their
 * earlier `kind === …` chains allowed). The rank's *value* is not compiler
 * checked; `anchor.test.ts` asserts every kind ranks distinctly.
 */
export const TIMER_PHASE_KINDS = ['prep', 'set', 'rest', 'activation'] as const;

/** The four things a timed session counts down. */
export type TimerPhaseKind = (typeof TIMER_PHASE_KINDS)[number];

/** A duration field on a preset, in whole seconds. */
export type TimerDurationField =
  | 'warmupSet'
  | 'workSet'
  | 'restWarmup'
  | 'restWork'
  | 'prep'
  | 'activation';

/** Every duration a preset carries, in seconds. */
export type TimerPresetDurations = Record<TimerDurationField, number>;

/**
 * One set of a lift, as the timer needs to see it.
 *
 * Deliberately its own type rather than `PlannedSet` from `apps/web` — the
 * dependency arrow points inward, so the web layer maps into this shape rather
 * than this package reaching outward for it.
 */
export interface TimerSetPlan {
  /**
   * Which duration field the set itself draws from.
   *
   * `activation` belongs only to the synthetic set the activation phase carries —
   * it never appears in {@link TimerLiftPlan.sets}, which the web layer maps from
   * `PlannedSet` (`'warmup' | 'work'` by construction).
   */
  type: 'warmup' | 'work' | 'activation';
  /** Display label, e.g. `Warm-up 1` or `Set 3`. */
  setLabel: string;
  /** Human-readable prescription, e.g. `5 × 135 lbs`. Display only. */
  spec: string;
}

/** One lift and its sets, in the order they will be performed. */
export interface TimerLiftPlan {
  /** Lift name — also the key used to look up a per-lift override. */
  lift: string;
  /**
   * Training role, when it is known — what the accessory rest context keys on.
   *
   * `undefined` means "no opinion", not "compound": a lift absent from both the
   * built-in catalog and the user's custom lifts simply falls through to the
   * preset. The web layer resolves this via `liftClassificationFor`; core never
   * looks it up itself, so a caller can also state it directly.
   */
  classification?: LiftClassification | undefined;
  /** Training-max caption, e.g. `TM: 285 lbs`. Display only. Explicitly `| undefined` for exactOptionalPropertyTypes. */
  tm?: string | undefined;
  /**
   * Activation movement performed once before this lift's first timed set, e.g.
   * `Hip Airplane`. Absent means the lift has none, and no activation phase is
   * emitted for it.
   *
   * Carried on the *lift* rather than on a set because an activation movement is
   * not a set: it has no weight and no training max, so it does not fit the web
   * layer's TM-derived `PlannedSet`. This mirrors the design mockup's own shape,
   * where `kind` is a property of a lift.
   */
  activation?: string | undefined;
  sets: TimerSetPlan[];
}

/** Alert style fired at the end of a phase. */
export type TimerAlertMode = 'Both' | 'Beep' | 'Vibrate' | 'Silent';

/** Non-duration behavior flags. */
export interface TimerBehavior {
  alert: TimerAlertMode;
  /** Tick at 3, 2, 1 before a *set* ends. Never before rest. */
  countdown3: boolean;
  /** Rest keeps counting past zero instead of auto-starting the next set. */
  countUp: boolean;
  /** Hold a screen wake lock while a run is active. */
  awake: boolean;
  /** Warm-ups run untimed — no prep, set, or rest phase is emitted for them. */
  skipWarmups: boolean;
}

/**
 * Duration overrides that apply to a *situation* rather than to one named lift.
 *
 * Deload is a manual week-scoped toggle; accessory is keyed off the lift's own
 * {@link TimerLiftPlan.classification}, so its toggle says whether the rule is in
 * force, not which lifts it hits. Deload outranks accessory — a deload week is
 * the more specific, deliberately-entered state.
 */
export interface TimerContext {
  deloadOn: boolean;
  deload: Partial<TimerPresetDurations>;
  /** Whether accessory lifts take their own shorter durations. */
  accessoryOn: boolean;
  /** Applied to a lift whose `classification` is `accessory`, while `accessoryOn`. */
  accessory: Partial<TimerPresetDurations>;
}

/** The complete persisted settings blob (`ll.timer.v1`). */
export interface TimerSettings {
  /** Key into `presets`. */
  preset: string;
  presets: Record<string, TimerPresetDurations>;
  /** Per-lift duration overrides, keyed by lift name. */
  overrides: Record<string, Partial<TimerPresetDurations>>;
  context: TimerContext;
  behavior: TimerBehavior;
}

/** One entry in the built session queue. */
export interface TimerPhase {
  kind: TimerPhaseKind;
  /** Phase label shown on the dial, e.g. `Get set`, `Working set`, `Rest`. */
  label: string;
  /** Duration in seconds, already resolved through the override chain. */
  dur: number;
  lift: string;
  tm?: string | undefined;
  /** The set this phase belongs to. */
  set: TimerSetPlan;
  /**
   * Index into the flat set list this phase belongs to — what the detail page
   * uses to mark rows active/done without comparing object identity.
   */
  setIndex: number;
  /**
   * Position of the lift occurrence this phase belongs to in the plan — the
   * first half of its shape-stable identity (see {@link TimerPhaseKey}).
   * Positional, never the name: the same lift can appear twice in one workout.
   */
  liftIndex: number;
  /**
   * Position of this phase's set within its lift's *full* set list, warm-ups
   * included — so, unlike `setIndex`, it does not renumber when `skipWarmups`
   * toggles. `-1` for an activation, which precedes every set of its lift.
   */
  setOrdinal: number;
  /** The next *set* phase after this one, for "Up next: …" copy. `null` at the end. */
  next: { lift: string; setLabel: string; spec: string } | null;
}

/**
 * Shape-stable identity of a phase in the session queue.
 *
 * A queue index is not one: toggling `skipWarmups`, or moving `prep` or
 * `activation` across zero, changes how many phases each set expands to and
 * renumbers everything after it. `setIndex` is not one either — it addresses
 * the *timed* set list, which is exactly what `skipWarmups` renumbers. What
 * survives every rebuild is *position in the plan*: which lift occurrence
 * (`liftIndex`), which of its sets (`setOrdinal`, counted over the lift's full
 * set list), and which of that set's phases (`kind`). See `./anchor` for the
 * ordering and re-anchoring helpers built on it.
 */
export interface TimerPhaseKey {
  liftIndex: number;
  setOrdinal: number;
  kind: TimerPhaseKind;
  /**
   * The lift's name — a sanity check, not part of the ordering. Position alone
   * would alias silently if the plan were reordered under a live run (a lift
   * inserted or removed ahead of the current one in the program editor); a
   * positional hit whose name differs is treated as "this plan is not the one
   * the run was anchored in" rather than resumed on someone else's set.
   */
  lift: string;
}

/**
 * A run in progress.
 *
 * `startedAt` / `pausedAt` are epoch milliseconds and `pausedMs` is accumulated
 * paused time, so elapsed is always a wall-clock subtraction rather than a sum
 * of ticks — see {@link elapsedSeconds}. That is what keeps the countdown honest
 * across a locked phone or a throttled background tab.
 */
export interface TimerRunState {
  /**
   * Index into the queue — a *cache* of where {@link TimerRunState.on} sits in
   * the queue as currently built. Re-derived from `on` whenever the queue is
   * rebuilt; never the source of truth for which phase the run is on.
   */
  idx: number;
  /**
   * The phase the run is on, by shape-stable identity. This is what survives a
   * queue rebuild — on this route, the other route, or a fresh mount whose
   * persisted settings build a different shape than the defaults did — where a
   * bare index would silently point at a different phase (issue #980).
   */
  on: TimerPhaseKey;
  startedAt: number;
  /** Total milliseconds spent paused across every pause so far. */
  pausedMs: number;
  /** Epoch ms the current pause began, or `null` when running. */
  pausedAt: number | null;
  /** Seconds added or removed by ±30s. Applies to rest phases only. */
  bonus: number;
  /** Workout this run belongs to — a run is never restored onto another workout. */
  workout: TimerWorkoutKey;
  /**
   * Each lift's classification, keyed by lift name, as it resolved when this run
   * started — snapshotted via {@link snapshotClassifications} and reapplied via
   * {@link applyClassifications}.
   *
   * The timer page and the workout-detail dock each resolve a custom lift's
   * classification independently (their own `fetchCustomLifts()` call, bounded
   * and caught so neither a failure nor a slow response can hold up a timer).
   * Without this, the same in-flight rest could end at a different time on each
   * surface — 4:00 on one, 1:30 on the other — for a lift one route classified
   * as an accessory and the other, mid-degrade, did not. Pinning the answer here
   * once, at the moment the run begins, means every later queue rebuild — on
   * either route, and including a mid-session reclassification of a custom lift
   * — reapplies the *same* answer rather than whatever this mount resolved on
   * its own. A lift absent from the map (new to the plan since the run started,
   * or the run was persisted before this field existed) falls through to
   * whatever the reapplying route resolves itself — see `applyClassifications`.
   *
   * `null`, not `undefined`, is how a pinned "no opinion" is stored: this field
   * round-trips through `JSON.stringify` on every persist (see `saveTimerRun`),
   * which drops an `undefined`-valued key outright but keeps a `null`-valued one.
   * A map entry that used `undefined` for "pinned, but this lift isn't
   * classified" would vanish across that round trip — indistinguishable from "no
   * pin was ever recorded" — silently reopening the exact cross-route
   * disagreement this field exists to close, specifically for whichever lift the
   * *first* route to start the run couldn't classify. `null` survives the round
   * trip, so "pinned to no opinion" and "no pin recorded" (key absent) stay
   * distinguishable — see `applyClassifications`, which maps a stored `null`
   * back to `undefined` on `TimerLiftPlan.classification`.
   */
  classifications: Record<string, LiftClassification | null>;
}

/** Identity of the workout a persisted run belongs to. */
export interface TimerWorkoutKey {
  program: string;
  cycleNum: number;
  workoutNum: number;
}
