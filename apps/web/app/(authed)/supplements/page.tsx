import type { Metadata } from 'next';
import { fetchSupplements } from '@/lib/api';
import { isIsoDay } from '@/lib/supplementHistory';
import SupplementsView from './SupplementsView';
import LoadError from './LoadError';
import styles from './supplements.module.css';

export const metadata: Metadata = { title: 'Supplements — Lifting Logbook' };

/**
 * `/supplements`: what the lifter takes, by day type. `?history=YYYY-MM-DD`, from a Lift History
 * link, opens the History dialog at that date; any other value is ignored.
 * The fetch is uncached (`no-store`, set in the api-client), so a saved link shows on the next load.
 */
export default async function SupplementsPage({ searchParams }: { searchParams: Promise<{ history?: string | string[] }> }) {
  const { history } = await searchParams;
  const historyDate = typeof history === 'string' && isIsoDay(history) ? history : undefined;
  const result = await fetchSupplements().then(
    (stack) => ({ stack }),
    // Logged here for the server's logs; the error state below also reports it from the browser.
    // fallback-covered-by: apps/web/app/(authed)/supplements/page.test.tsx
    (err: unknown) => {
      console.error('[SupplementsPage] supplements fetch failed', err);
      return { error: err instanceof Error ? err.message : 'Request failed' };
    },
  );
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>What I’m on</h1>
      {'stack' in result ? <SupplementsView stack={result.stack} historyDate={historyDate} /> : <LoadError message={result.error} />}
    </main>
  );
}
