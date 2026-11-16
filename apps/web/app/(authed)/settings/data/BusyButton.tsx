'use client';

import type { ReactNode, Ref } from 'react';
import styles from './BusyButton.module.css';

/**
 * A button that ignores presses while `busy`. It's marked aria-disabled rather than disabled: a
 * browser moves focus off a focused element once it's disabled (the HTML focus fixup rule), so the
 * button that started the work would drop keyboard focus to the page's body.
 * https://html.spec.whatwg.org/multipage/webappapis.html#focus-fixup-rule
 */
export default function BusyButton({
  busy,
  onClick,
  children,
  ref,
}: {
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={styles.button}
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onClick}
    >
      {children}
    </button>
  );
}
