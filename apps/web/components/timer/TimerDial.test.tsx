import { render } from '@testing-library/react';
import { TIMER_PHASE_KINDS } from '@lifting-logbook/core';
import type { TimerPhaseKind } from '@lifting-logbook/core';
import TimerDial from './TimerDial';

/**
 * The dial's phase -> class chain, which `scripts/check-timer-phase-colors.mjs`
 * cannot see.
 *
 * That guard checks the *stylesheet* half of the pairing — that no two phases
 * resolve to the same colour in a theme. It reads `TimerDial.module.css`, not
 * `TimerDial.tsx`, so it cannot tell whether the component ever applies a class.
 * And the chain ends in `styles.set` as its fallthrough, so a phase kind added
 * without a branch paints accent-coloured, typechecks, and passes that guard.
 * These assertions close that half.
 *
 * CSS modules resolve through `identity-obj-proxy` under jest, so `styles.rest`
 * is the literal string `'rest'`.
 */
function fillClasses(kind: TimerPhaseKind | null, overrun = false): string {
  const { container } = render(
    <TimerDial size={100} stroke={8} progress={0.5} kind={kind} overrun={overrun} />,
  );
  const circles = container.querySelectorAll('circle');
  // Two circles: the track, then the progress fill the phase colours.
  return circles[1]?.getAttribute('class') ?? '';
}

describe('TimerDial phase colours', () => {
  // Driven off TIMER_PHASE_KINDS, not a local literal: a phase kind added to the
  // union is added to that array by construction (the type is derived from it),
  // so a new kind enters this table automatically and fails here until it gets a
  // branch. A hand-written list would silently keep testing the old four.
  it.each(TIMER_PHASE_KINDS.map((kind) => [kind] as const))(
    'paints a %s phase with a class of its own name',
    (kind) => {
      expect(fillClasses(kind)).toContain(kind);
    },
  );

  it('gives every phase kind a distinct class', () => {
    // The per-kind rows above would each still pass if two kinds shared a class
    // whose name happened to contain both — and "activation falls through to
    // .set" is exactly the silent failure this file exists to catch. Assert
    // distinctness directly, over the same derived list.
    const painted = TIMER_PHASE_KINDS.map((kind) => fillClasses(kind));
    expect(new Set(painted).size).toBe(TIMER_PHASE_KINDS.length);
  });

  it('paints overrun regardless of the underlying phase', () => {
    expect(fillClasses('activation', true)).toContain('overrun');
    expect(fillClasses('rest', true)).toContain('overrun');
  });

  it('falls back to the set colour before a session starts', () => {
    expect(fillClasses(null)).toContain('set');
  });
});
