import { render } from '@testing-library/react';
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
  it.each([
    ['set', 'set'],
    ['rest', 'rest'],
    ['prep', 'prep'],
    ['activation', 'activation'],
  ] as const)('paints a %s phase with the %s class', (kind, expected) => {
    expect(fillClasses(kind)).toContain(expected);
  });

  it('gives every phase kind a class of its own', () => {
    // The point of the table above is that no two share one. Asserted directly,
    // because "activation falls through to .set" is exactly the silent failure
    // this file exists to catch, and it would still satisfy a per-row check that
    // only looked for a non-empty class.
    const kinds: TimerPhaseKind[] = ['set', 'rest', 'prep', 'activation'];
    const painted = kinds.map((kind) => fillClasses(kind));
    expect(new Set(painted).size).toBe(kinds.length);
  });

  it('paints overrun regardless of the underlying phase', () => {
    expect(fillClasses('activation', true)).toContain('overrun');
    expect(fillClasses('rest', true)).toContain('overrun');
  });

  it('falls back to the set colour before a session starts', () => {
    expect(fillClasses(null)).toContain('set');
  });
});
