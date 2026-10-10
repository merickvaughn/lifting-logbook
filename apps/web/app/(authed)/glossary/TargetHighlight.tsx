'use client';

import { useEffect } from 'react';

/** Attribute the stylesheet keys the highlighted entry on (`[data-targeted]`). */
export const TARGETED_ATTR = 'data-targeted';

/** The element id a URL hash names; '' when absent or not valid percent-encoding. */
function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    // A malformed escape (`#%E0`) names no glossary entry; highlight nothing
    // rather than throw out of the effect. Covered by page.test.tsx.
    return '';
  }
}

/**
 * Marks the glossary entry named by the URL hash so it can be highlighted.
 *
 * CSS `:target` alone is not enough: a `GlossaryLink` click is an App Router
 * soft navigation, which updates the URL with `history.pushState`, and
 * `pushState` does not change `:target`. The router writes history in
 * `useInsertionEffect`, which runs before this `useEffect` in the same commit,
 * so the hash is already in place on mount. `hashchange` and `popstate` cover a
 * typed hash and back/forward.
 */
export default function TargetHighlight() {
  useEffect(() => {
    const apply = () => {
      for (const el of document.querySelectorAll(`[${TARGETED_ATTR}]`)) {
        el.removeAttribute(TARGETED_ATTR);
      }
      const id = decodeHash(window.location.hash);
      if (id) document.getElementById(id)?.setAttribute(TARGETED_ATTR, 'true');
    };
    apply();
    window.addEventListener('hashchange', apply);
    window.addEventListener('popstate', apply);
    return () => {
      window.removeEventListener('hashchange', apply);
      window.removeEventListener('popstate', apply);
    };
  }, []);
  return null;
}
