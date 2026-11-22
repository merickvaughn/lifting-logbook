import type { Metadata } from 'next';
import Link from 'next/link';
import { fetchSupplementChanges, fetchSupplements, fetchSupplementsAsOf } from '@/lib/api';
import { isIsoDay } from '@/lib/supplementHistory';
import { getUserToday } from '@/lib/userToday';
import LoadError from '../LoadError';
import styles from '../supplements.module.css';
import HistoryView from './HistoryView';

export const metadata: Metadata = { title: 'Supplement history — Lifting Logbook' };

/**
 * `/supplements/history?date=YYYY-MM-DD`: the stack at the end of that day (today without a
 * date, or with one that isn't a calendar day), and the change log. Lift History links here.
 * The fetches are uncached (`no-store`, set in the api-client).
 */
export default async function SupplementHistoryPage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const { date: asked } = await searchParams;
  const today = await getUserToday();
  const date = typeof asked === 'string' && isIsoDay(asked) ? asked : today;
  const result = await Promise.all([fetchSupplementsAsOf(date), fetchSupplementChanges(), fetchSupplements()]).then(
    ([asOf, changes, current]) => ({ asOf, changes, current }),
    // Logged here for the server's logs; the error state below also reports it from the browser.
    // fallback-covered-by: apps/web/app/(authed)/supplements/history/page.test.tsx
    (err: unknown) => {
      console.error('[SupplementHistoryPage] history fetch failed', err);
      return { error: err instanceof Error ? err.message : 'Request failed' };
    },
  );
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Supplement history</h1>
      <p className={styles.subtitle}>
        <Link href="/supplements">Back to what I’m on</Link>
      </p>
      {'error' in result ? <LoadError message={result.error} /> : <HistoryView date={date} {...result} />}
    </main>
  );
}
