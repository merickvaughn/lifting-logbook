import { fetchBarbellComplexes, fetchCustomLifts } from '@/lib/api';
import ComplexesEditor from './ComplexesEditor';

export default async function ComplexesPage() {
  const [complexes, customLifts] = await Promise.all([
    fetchBarbellComplexes(),
    // Custom lifts only widen the lift choices, so the page still renders with the catalog's
    // when they can't be read.
    // fallback-covered-by: apps/web/app/(authed)/settings/complexes/page.test.tsx
    fetchCustomLifts().catch((err: unknown) => {
      console.error('[ComplexesPage] custom lifts fetch failed, offering catalog lifts only', err);
      return [];
    }),
  ]);
  return (
    <ComplexesEditor initialComplexes={complexes} customLifts={customLifts.map(({ id, name }) => ({ id, name }))} />
  );
}
