'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './AppNav.module.css';

/** Primary destinations surfaced on every authed screen. */
const LINKS: ReadonlyArray<{ href: string; label: string; match: string }> = [
  { href: '/history', label: 'History', match: '/history' },
  { href: '/programs', label: 'Programs', match: '/programs' },
  // The program and focus blocks on one timeline (#1059).
  { href: '/calendar', label: 'Calendar', match: '/calendar' },
  { href: '/glossary', label: 'Glossary', match: '/glossary' },
  // Points at the /settings hub (#679), which lists every settings section plus
  // the Import tool; `match` keeps this active across the whole /settings/* subtree.
  { href: '/settings', label: 'Settings', match: '/settings' },
];

/**
 * Persistent top navigation for the authenticated app shell. Rendered once by
 * the (authed) layout so every protected screen has a consistent, styled way to
 * move between sections — replacing the unstyled, dashboard-only nav that left
 * /programs a dead-end (#678).
 */
export default function AppNav() {
  const pathname = usePathname() ?? '';
  // Onboarding is a focused, nav-free flow — surfacing History/Programs/Settings
  // before setup completes would let a user wander out mid-onboarding. Matches the
  // pre-shell behavior, where the nav lived only under the macrocycle layout.
  if (pathname.startsWith('/onboarding')) return null;

  return (
    <header className={styles.appHeader}>
      <Link href="/macrocycle" className={styles.brand}>
        Lifting Logbook
      </Link>
      <nav aria-label="Primary" className={styles.nav}>
        {LINKS.map(({ href, label, match }) => {
          // Boundary-safe: exact hub match or a real sub-path, so a sibling like
          // `/settings-export` can't mis-highlight `/settings` (mirrors SettingsNav).
          const active = pathname === match || pathname.startsWith(`${match}/`);
          return (
            <Link
              key={href}
              href={href}
              className={active ? `${styles.link} ${styles.active}` : styles.link}
              aria-current={active ? 'page' : undefined}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
