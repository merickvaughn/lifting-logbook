import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getActiveProgram } from '@/lib/active-program';
import { loadWorkoutPlan } from '@/lib/loadWorkoutPlan';
import { isTimeable } from '@/lib/workoutStatus';
import WorkoutTimerProvider from '@/components/timer/WorkoutTimerProvider';
import CollapsibleLiftList from './CollapsibleLiftList';
import StartTimedWorkout from './StartTimedWorkout';
import RescheduleForm from './RescheduleForm';
import SkipForm from './SkipForm';
import styles from './detail.module.css';

export default async function WorkoutDetailPage({
  params,
}: {
  params: Promise<{ cycleNum: string; workoutNum: string }>;
}) {
  const { cycleNum: cycleNumParam, workoutNum: workoutNumParam } = await params;
  const cycleNum = Number(cycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(cycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const program = await getActiveProgram();
  // One loader for this page and the timer route, so the plan the dock counts
  // down and the plan the timer page displays are the same computation. Its
  // custom-lift fetch is started up front but awaited only through
  // `plan.timerLifts()` — see `WorkoutPlan.timerLifts` for why that matters on
  // the app's most-visited page.
  const plan = await loadWorkoutPlan(program, workoutNum);

  if (!plan) {
    notFound();
    return null;
  }

  const { workout, unit, status, liftDetails } = plan;
  const effectiveDate = workout.overrideDate ?? workout.date;
  // `status`: completed wins over skipped intentionally — a partially-logged
  // workout can also be marked skipped (the two states are independent
  // records); when both are true the workout still shows as completed and
  // SkipForm is hidden. See `statusOf`.

  // A finished or skipped workout has nothing left to time, so the timer is not
  // mounted at all rather than being mounted and hidden. The timer route applies
  // the same check via `isTimeable`, so the two surfaces cannot disagree.
  const timerAvailable = isTimeable(status);
  const timerLifts = timerAvailable ? await plan.timerLifts() : [];

  const plannedSets = liftDetails.reduce((acc, d) => acc + d.warmUpCount + d.workCount, 0);
  const actualSets = workout.lifts.reduce((acc, wl) => acc + wl.sets.length, 0);
  const displaySets = status === 'completed' ? actualSets : plannedSets;

  const statusLabel =
    status === 'completed' ? '✓ Done'
    : status === 'upcoming' ? 'Upcoming'
    : status === 'skipped' ? '⊘ Skipped'
    : 'Missed';

  const body = (
    <>
      <Link href={`/cycle/${cycleNum}`} className={styles.backLink}>
        ← Back to Cycle
      </Link>

      <header className={styles.header}>
        <div className={styles.headerMeta}>
          <time dateTime={effectiveDate} className={styles.date}>
            {effectiveDate}
            {workout.overrideDate && (
              <span className={styles.rescheduled}> (rescheduled)</span>
            )}
          </time>
          <span className={styles.weekLabel}>Week {workout.week}</span>
        </div>
        <span className={`${styles.badge} ${styles[`badge_${status}`]}`}>
          {statusLabel}
        </span>
      </header>

      <section className={styles.summarySection}>
        <h2 className={styles.summaryTitle}>Workout Summary</h2>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Total Lifts</span>
            <span className={styles.summaryValue}>{liftDetails.length}</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>
              {status === 'completed' ? 'Sets Logged' : 'Total Sets'}
            </span>
            <span className={styles.summaryValue}>{displaySets}</span>
          </div>
        </div>
      </section>

      <section className={styles.liftsSection}>
        <h2 className={styles.sectionHeading}>Planned Lifts</h2>
        <CollapsibleLiftList
          liftDetails={liftDetails}
          cycleNum={cycleNum}
          workoutNum={workoutNum}
          unit={unit}
        />
      </section>

      <section className={styles.actions}>
        {timerAvailable && <StartTimedWorkout cycleNum={cycleNum} workoutNum={workoutNum} />}
        <Link
          href={`/cycle/${cycleNum}/workout/${workoutNum}/detail/manage-lifts`}
          className={styles.btnSecondary}
        >
          ✏️ Manage Lifts
        </Link>
        {timerAvailable && (
          <Link
            href={`/cycle/${cycleNum}/workout/${workoutNum}`}
            className={styles.btnSecondary}
          >
            Start Logging (untimed)
          </Link>
        )}
        <RescheduleForm
          program={program}
          cycleNum={cycleNum}
          workoutNum={workoutNum}
          currentDate={effectiveDate}
        />
        {status !== 'completed' && (
          <SkipForm
            program={program}
            cycleNum={cycleNum}
            workoutNum={workoutNum}
            skipped={workout.skipped}
          />
        )}
      </section>
    </>
  );

  return (
    <main className={styles.container}>
      {timerAvailable ?
        <WorkoutTimerProvider
          lifts={timerLifts}
          program={program}
          cycleNum={cycleNum}
          workoutNum={workoutNum}
        >
          {body}
        </WorkoutTimerProvider>
      : body}
    </main>
  );
}
