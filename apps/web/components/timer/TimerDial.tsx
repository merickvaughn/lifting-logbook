'use client';

import type { TimerPhaseKind } from '@lifting-logbook/core';
import styles from './TimerDial.module.css';

/**
 * Which stylesheet class paints each phase.
 *
 * Exhaustive by type: `TimerPhaseKind` is derived from `TIMER_PHASE_KINDS`, so
 * a kind added there without an entry here is a compile error — not a phase
 * that silently paints accent-coloured, which is what the old `kind === …`
 * chain with its `styles.set` fallthrough allowed. What the type cannot see is
 * two kinds sharing one class; `TimerDial.test.tsx` asserts distinctness, and
 * `scripts/check-timer-phase-colors.mjs` reads this file's stylesheet to catch
 * two classes resolving to one colour.
 */
const PHASE_CLASS = {
  set: styles.set,
  rest: styles.rest,
  prep: styles.prep,
  activation: styles.activation,
} satisfies Record<TimerPhaseKind, string>;

interface Props {
  /** Outer diameter in px. The ring is inset by `stroke`. */
  size: number;
  stroke: number;
  /** 0–1. Drives how much of the ring is painted. */
  progress: number;
  kind: TimerPhaseKind | null;
  overrun: boolean;
  /** Rendered inside the ring. Omit for the bare ring used by the dock. */
  children?: React.ReactNode;
}

/**
 * The countdown ring.
 *
 * Shared by the timer page (large), the expanded sheet (medium) and the docked
 * mini-timer (small) so all three read as the same object at different scales,
 * and so the phase→color mapping lives in exactly one place.
 *
 * The SVG is `aria-hidden`: it conveys nothing the numeric time beside it does
 * not already carry, and a screen reader announcing a partial ring is noise.
 */
export default function TimerDial({ size, stroke, progress, kind, overrun, children }: Props) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Painting from the far end means offset shrinks as progress grows, so the ring
  // fills clockwise from 12 o'clock (the -90° rotation is applied in CSS).
  const offset = circumference * (1 - Math.min(1, Math.max(0, progress)));

  // Before a session starts there is no phase; the idle ring wears the set
  // colour (the accent). Overrun paints over whichever phase is running.
  const phaseClass =
    overrun ? styles.overrun
    : kind === null ? styles.set
    : PHASE_CLASS[kind];

  return (
    <div className={styles.dial} style={{ width: size, height: size }}>
      <svg className={styles.svg} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle
          className={styles.track}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
        />
        <circle
          className={`${styles.fill} ${phaseClass}`}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      {children != null && <div className={styles.content}>{children}</div>}
    </div>
  );
}
