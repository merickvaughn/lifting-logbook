import { notFound } from 'next/navigation';
import Link from 'next/link';
import { fetchLiftCatalog } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import LiftPicker from './LiftPicker';
import styles from './pick.module.css';

export default async function LiftPickerPage({
  params,
  searchParams,
}: {
  params: Promise<{ macrocycleNum: string; workoutNum: string }>;
  searchParams: Promise<{ action?: string; replacing?: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam, workoutNum: workoutNumParam } = await params;
  const { action, replacing } = await searchParams;

  const macrocycleNum = Number(macrocycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(macrocycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const validAction = action === 'replace' ? 'replace' : 'add';
  const program = await getActiveProgram();
  const catalog = await fetchLiftCatalog(program);

  const backHref = `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts`;
  const title = validAction === 'replace' ? `Replace ${replacing ?? 'lift'}` : 'Add Lift';

  return (
    <main className={styles.container}>
      <Link href={backHref} className={styles.backLink}>
        ← Back to Manage Lifts
      </Link>

      <header className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </header>

      <LiftPicker
        program={program}
        macrocycleNum={macrocycleNum}
        workoutNum={workoutNum}
        action={validAction}
        replacing={replacing}
        catalog={catalog}
        backHref={backHref}
      />
    </main>
  );
}
