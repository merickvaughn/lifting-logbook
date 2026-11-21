import type { Metadata } from 'next';
import { fetchSupplements } from '@/lib/api';
import SupplementsView from './SupplementsView';
import LoadError from './LoadError';
import styles from './supplements.module.css';

export const metadata: Metadata = { title: 'Supplements — Lifting Logbook' };

/**
 * `/supplements`: what the lifter takes, by day type. Read-only; editing is a later change.
 * The fetch is uncached (`no-store`, set in the api-client), so a saved link shows on the next load.
 */
export default async function SupplementsPage() {
  const result = await fetchSupplements().then(
    (stack) => ({ stack }),
    // The error state below reports it through logClientError, which needs the browser.
    // fallback-covered-by: apps/web/app/(authed)/supplements/page.test.tsx
    (err: unknown) => ({ error: err instanceof Error ? err.message : 'Request failed' }),
  );
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>What I’m on</h1>
      {'stack' in result ? <SupplementsView stack={result.stack} /> : <LoadError message={result.error} />}
    </main>
  );
}
