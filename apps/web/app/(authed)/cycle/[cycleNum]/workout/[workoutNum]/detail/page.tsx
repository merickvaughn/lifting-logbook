import { notFound } from 'next/navigation';
import Link from 'next/link';
import { fetchWorkout, fetchProgramSpec, fetchTrainingMaxes, fetchCustomLifts } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';
import { computePlannedSets } from '@/lib/workoutPlan';
import { CUSTOM_LIFTS_TIMEOUT_MS, toTimerLiftPlans } from '@/lib/timerPlan';
import { withTimeout } from '@/lib/with-timeout';
import { isTimeable, workoutStatus } from '@/lib/workoutStatus';
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

  // Started here rather than inside the Promise.all below, and awaited only if the
  // timer is actually mounted (see `timerAvailable`). Most views of this page are
  // of completed workouts, where `timerLifts` is `[]` and this result is discarded
  // — so awaiting it unconditionally would put a round-trip on the critical path
  // of the app's most-visited page precisely when it is thrown away. The `.catch`
  // is attached at creation, so an unawaited rejection is impossible.
  //
  // Bounded as well as caught: neither a failure nor a slow response may hold up
  // the page for an enrichment that only shortens accessory rest. The timeout is
  // separate from the api-client's own `AbortSignal.timeout(30s)`, which is a
  // failure bound; `onTimeout` logs distinctly so "slow" and "down" stay tellable
  // apart in the logs.
  // fallback-covered-by: apps/web/app/(authed)/cycle/[cycleNum]/workout/[workoutNum]/detail/page.test.tsx
  const customLiftsPromise = withTimeout(
    fetchCustomLifts().catch((err: unknown) => {
      console.error('WorkoutDetailPage: custom lifts fetch failed, classifying built-ins only', err);
      return [];
    }),
    CUSTOM_LIFTS_TIMEOUT_MS,
    [],
    () => console.warn('WorkoutDetailPage: custom lifts fetch slow, classifying built-ins only'),
  );

  const [workout, specs, maxes, unit] = await Promise.all([
    fetchWorkout(program, workoutNum),
    fetchProgramSpec(program),
    fetchTrainingMaxes(program),
    getPreferredUnit(),
  ]);

  if (!workout) {
    notFound();
    return null;
  }

  const effectiveDate = workout.overrideDate ?? workout.date;
  const hasLogs = workout.lifts.some((l) => !l.planned);
  // completed wins over skipped intentionally: a partially-logged workout can also be
  // marked skipped (the two states are independent records). When both are true the
  // workout still shows as completed and SkipForm is hidden.
  const status = workoutStatus(effectiveDate, hasLogs, workout.skipped);
  const maxMap = new Map(maxes.map((m) => [m.lift, m.weight]));

  // For each lift, compute warm-up and work set counts from spec
  const liftDetails = workout.lifts.map((wl) => {
    const tm = maxMap.get(wl.lift) ?? 0;
    const spec = specs.find((s) => s.week === workout.week && s.lift === wl.lift);
    const plannedSets = spec ? computePlannedSets(spec, tm) : [];
    const warmUpCount = plannedSets.filter((s) => s.setLabel.startsWith('Warm-up')).length;
    const workCount = plannedSets.filter((s) => s.setLabel.startsWith('Set')).length;
    return { lift: wl.lift, tm, warmUpCount, workCount, plannedSets };
  });

  // A finished or skipped workout has nothing left to time, so the timer is not
  // mounted at all rather than being mounted and hidden. The timer route applies
  // the same check via `isTimeable`, so the two surfaces cannot disagree.
  const timerAvailable = isTimeable(status);
  const timerLifts =
    timerAvailable ? toTimerLiftPlans(liftDetails, unit, await customLiftsPromise) : [];

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
