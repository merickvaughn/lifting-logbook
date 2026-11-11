import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { fetchLiftCatalog, fetchWorkout } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { MACROCYCLE_ID_PARAM, movedWorkoutPath, withMacrocycleId } from '@/lib/macrocycleUrl';
import LiftPicker from './LiftPicker';
import styles from './pick.module.css';

export default async function LiftPickerPage({
  params,
  searchParams,
}: {
  params: Promise<{ macrocycleNum: string; workoutNum: string }>;
  searchParams: Promise<{ action?: string; replacing?: string; [MACROCYCLE_ID_PARAM]?: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam, workoutNum: workoutNumParam } = await params;
  const { action, replacing, [MACROCYCLE_ID_PARAM]: linkedId } = await searchParams;

  const macrocycleNum = Number(macrocycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(macrocycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const validAction = action === 'replace' ? 'replace' : 'add';
  const program = await getActiveProgram();
  // The write sends the macrocycle's id (#1198). Manage Lifts links here with it, so the
  // workout is read only for a link without one, such as a bookmark.
  const [catalog, macrocycleId] = await Promise.all([
    fetchLiftCatalog(program),
    linkedId ?? currentMacrocycleId(program, macrocycleNum, workoutNum, validAction, replacing),
  ]);

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
        macrocycleId={macrocycleId}
        workoutNum={workoutNum}
        action={validAction}
        replacing={replacing}
        catalog={catalog}
        backHref={backHref}
      />
    </main>
  );
}

/**
 * The id of the macrocycle the workout is read from. A URL naming another number redirects
 * there, keeping the picker's query.
 */
async function currentMacrocycleId(
  program: string,
  macrocycleNum: number,
  workoutNum: number,
  action: 'add' | 'replace',
  replacing: string | undefined,
): Promise<string | undefined> {
  const workout = await fetchWorkout(program, workoutNum);
  if (!workout) notFound();
  const moved = movedWorkoutPath(
    `/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts/pick`,
    macrocycleNum,
    workout.macrocycleNum,
  );
  if (moved) {
    const query = new URLSearchParams({ action, ...(replacing !== undefined && { replacing }) });
    redirect(withMacrocycleId(`${moved}?${query.toString()}`, workout.macrocycleId));
  }
  return workout.macrocycleId;
}
