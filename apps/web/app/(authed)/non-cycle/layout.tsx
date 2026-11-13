import RepMaxCalculator from '@/components/RepMaxCalculator';
import { getPreferredUnit } from '@/lib/preferences';

/** Non-cycle workouts show the rep max calculator, as a program's workouts do (#1183, #1184). */
export default async function NonCycleLayout({ children }: { children: React.ReactNode }) {
  const unit = await getPreferredUnit();
  return (
    <>
      {children}
      <RepMaxCalculator unit={unit} />
    </>
  );
}
