import RepMaxCalculator from '@/components/RepMaxCalculator';
import { getPreferredUnit } from '@/lib/preferences';

/**
 * What every view of a workout shares: the rep max calculator (#1183). Mounted here, not
 * per page, so it can't be missing from a view, and its entries survive moving between them.
 */
export default async function WorkoutLayout({ children }: { children: React.ReactNode }) {
  const unit = await getPreferredUnit();
  return (
    <>
      {children}
      <RepMaxCalculator unit={unit} />
    </>
  );
}
