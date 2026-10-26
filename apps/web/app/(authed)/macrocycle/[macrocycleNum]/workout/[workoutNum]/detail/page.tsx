import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getActiveProgram } from '@/lib/active-program';
import { fetchFocusPlan } from '@/lib/api';
import { loadWorkoutPlan } from '@/lib/loadWorkoutPlan';
import { isTimeable } from '@/lib/workoutStatus';
import WorkoutTimerProvider from '@/components/timer/WorkoutTimerProvider';
import CollapsibleLiftList from './CollapsibleLiftList';
import FocusWorkout from './FocusWorkout';
import StartTimedWorkout from './StartTimedWorkout';
import RescheduleForm from './RescheduleForm';
import SkipForm from './SkipForm';
import styles from './detail.module.css';

export default async function WorkoutDetailPage({
  params,
}: {
  params: Promise<{ macrocycleNum: string; workoutNum: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam, workoutNum: workoutNumParam } = await params;
  const macrocycleNum = Number(macrocycleNumParam);
  const workoutNum = Number(workoutNumParam);

  if (!Number.isInteger(macrocycleNum) || !Number.isInteger(workoutNum) || workoutNum < 1) {
    notFound();
  }

  const program = await getActiveProgram();
  // One loader for this page and the timer route, so the plan the dock counts
  // down and the plan the timer page displays are the same computation. Its
  // custom-lift fetch is started up front but awaited only through
  // `plan.timerLifts()` — see `WorkoutPlan.timerLifts` for why that matters on
  // the app's most-visited page.
  const plan = await loadWorkoutPlan(program, workoutNum, 'WorkoutDetailPage');

  if (!plan) {
    notFound();
    return null;
  }

  // `effectiveDate` comes off the plan rather than being recomputed here, so the
  // date this page displays is the same one `statusOf` derived the status from.
  const { workout, unit, status, effectiveDate, liftDetails } = plan;

  // A finished or skipped workout has nothing left to time, so the timer is not
  // mounted at all rather than being mounted and hidden. The timer route applies
  // the same check via `isTimeable`, so the two surfaces cannot disagree.
  const timerAvailable = isTimeable(status);
  // Focus work (#1058) is offered on the same workouts the timer is: there is no
  // focus work left to do on one already logged or skipped. A failed fetch is
  // not fatal: the page falls back to the planned lifts with a notice.
  const [timerLifts, focus] = await Promise.all([
    timerAvailable ? plan.timerLifts() : Promise.resolve([]),
    timerAvailable ?
      fetchFocusPlan(program, workoutNum, new Date().toISOString().slice(0, 10)).then(
        (focusPlan) => ({ plan: focusPlan, failed: false }),
        (err: unknown) => {
          console.error('[WorkoutDetailPage] focus plan fetch failed, showing planned lifts only', err);
          return { plan: null, failed: true };
        },
      )
    : Promise.resolve({ plan: null, failed: false }),
  ]);
  // Without an active focus block the page keeps its plain layout.
  const focusPlan = focus.plan !== null && focus.plan.groups.length > 0 ? focus.plan : null;

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
      <Link href={`/macrocycle/${macrocycleNum}`} className={styles.backLink}>
        ← Back to macrocycle
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

      {focusPlan ?
        <FocusWorkout
          program={program}
          macrocycleNum={macrocycleNum}
          workoutNum={workoutNum}
          week={workout.week}
          unit={unit}
          liftDetails={liftDetails}
          plan={focusPlan}
        />
      : <>
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

          {focus.failed && (
            <p className={styles.focusNotice} role="status">
              Focus work couldn’t load, so only the planned lifts are shown.
            </p>
          )}

          <section className={styles.liftsSection}>
            <h2 className={styles.sectionHeading}>Planned Lifts</h2>
            <CollapsibleLiftList
              liftDetails={liftDetails}
              macrocycleNum={macrocycleNum}
              workoutNum={workoutNum}
              unit={unit}
            />
          </section>
        </>
      }

      <section className={styles.actions}>
        {timerAvailable && <StartTimedWorkout macrocycleNum={macrocycleNum} workoutNum={workoutNum} />}
        <Link
          href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}/detail/manage-lifts`}
          className={styles.btnSecondary}
        >
          ✏️ Manage Lifts
        </Link>
        {timerAvailable && (
          <Link
            href={`/macrocycle/${macrocycleNum}/workout/${workoutNum}`}
            className={styles.btnSecondary}
          >
            Start Logging (untimed)
          </Link>
        )}
        <RescheduleForm
          program={program}
          macrocycleNum={macrocycleNum}
          workoutNum={workoutNum}
          currentDate={effectiveDate}
        />
        {status !== 'completed' && (
          <SkipForm
            program={program}
            macrocycleNum={macrocycleNum}
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
          macrocycleNum={macrocycleNum}
          workoutNum={workoutNum}
        >
          {body}
        </WorkoutTimerProvider>
      : body}
    </main>
  );
}
