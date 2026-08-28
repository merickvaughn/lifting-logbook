'use client';

import type { TimerPhaseKind } from '@lifting-logbook/core';
import styles from './TimerDial.module.css';

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

  const phaseClass =
    overrun ? styles.overrun
    : kind === 'rest' ? styles.rest
    : kind === 'prep' ? styles.prep
    : styles.set;

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
