import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { fetchMacrocycleDashboard, fetchProgramSpec } from '@/lib/api';
import { getActiveProgram } from '@/lib/active-program';
import GlossaryLink from '@/components/GlossaryLink';
import {
  deriveProgramPhases,
  deriveProgramSummary,
  estimateCompletionDate,
  PHASE_STATUS_LABELS,
  resolveProgramPlanMeta,
  WEEK_TYPE_LABELS,
} from '@/lib/programPlan';
import { buildWorkoutDays } from '@/lib/workoutPlan';
import styles from './plan.module.css';

const STATUS_ICON: Record<keyof typeof PHASE_STATUS_LABELS, string> = {
  completed: '✓',
  'in-progress': '◆',
  upcoming: '→',
};

export default async function ProgramPlanPage({
  params,
}: {
  params: Promise<{ macrocycleNum: string }>;
}) {
  const { macrocycleNum: macrocycleNumParam } = await params;
  const requestedMacrocycleNum = Number.parseInt(macrocycleNumParam, 10);
  if (Number.isNaN(requestedMacrocycleNum) || requestedMacrocycleNum < 1) notFound();
  const program = await getActiveProgram();

  const [dashboard, specs] = await Promise.all([
    fetchMacrocycleDashboard(program),
    fetchProgramSpec(program),
  ]);

  if (!dashboard || dashboard.macrocycleNum !== requestedMacrocycleNum) {
    redirect(`/macrocycle/${dashboard?.macrocycleNum ?? 1}/plan`);
  }

  const meta = resolveProgramPlanMeta(program, specs);
  const { durationWeeks } = deriveProgramSummary(specs, program);
  const today = new Date().toISOString().slice(0, 10);
  const phases = deriveProgramPhases(dashboard.weeks, today, meta);
  const estCompletion = estimateCompletionDate(
    buildWorkoutDays(specs, dashboard.macrocycleStartDate, program),
    dashboard,
  );

  return (
    <section className={styles.container}>
      <div className={styles.backRow}>
        <Link href={`/macrocycle/${dashboard.macrocycleNum}`}>← Back to macrocycle</Link>
      </div>

      <h1 className={styles.heading}>Macrocycle plan</h1>

      <dl className={styles.dataList}>
        <div className={styles.dataRow}>
          <dt>Start date</dt>
          <dd>{dashboard.macrocycleStartDate}</dd>
        </div>
        <div className={styles.dataRow}>
          <dt>Est. completion</dt>
          <dd>{estCompletion}</dd>
        </div>
        <div className={styles.dataRow}>
          <dt>Total weeks</dt>
          <dd>{durationWeeks}</dd>
        </div>
      </dl>

      <div className={styles.sectionLabelRow}>
        <h2 className={styles.sectionLabel}>
          {meta.phaseStyle === 'mesocycle' ? 'Mesocycles' : 'Phases'}
        </h2>
        <GlossaryLink id={meta.phaseStyle === 'mesocycle' ? 'mesocycle' : 'phase'} />
      </div>
      <ul className={styles.phaseList}>
        {phases.map((phase) => (
          <li
            key={`${phase.name}-${phase.startWeek}`}
            className={`${styles.phaseCard} ${styles[`phase_${phase.type}`]} ${styles[`status_${phase.status}`]}`}
          >
            <div className={styles.phaseMain}>
              <span className={styles.phaseName}>{phase.name}</span>
              <span className={styles.phaseWeeks}>
                {phase.startWeek === phase.endWeek
                  ? `Week ${phase.startWeek}`
                  : `Weeks ${phase.startWeek}–${phase.endWeek}`}
              </span>
            </div>
            <div className={styles.phaseMeta}>
              <span className={`${styles.typeBadge} ${styles[`typeBadge_${phase.type}`]}`}>
                {WEEK_TYPE_LABELS[phase.type]}
              </span>
              {/* aria-label on a role-less <span> is ignored by assistive tech, so the
                  status is spoken from visually hidden text and the icon is hidden. */}
              <span className={styles.statusIcon} title={PHASE_STATUS_LABELS[phase.status]}>
                <span aria-hidden="true">{STATUS_ICON[phase.status]}</span>
                <span className={styles.srOnly}>{PHASE_STATUS_LABELS[phase.status]}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
