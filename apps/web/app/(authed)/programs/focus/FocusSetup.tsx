'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { daysLeft, rangeLabel } from '@lifting-logbook/core';
import {
  FOCUS_AREAS,
  type CreateFocusBlockRequest,
  type FocusArea,
  type FocusBlock,
  type FocusBudget,
  type FocusDayPlanResponse,
  type UpdateFocusBlockRequest,
  type WeightUnit,
} from '@lifting-logbook/types';
import { Field } from '@/components/form/Field';
import { Select } from '@/components/form/Select';
import { Stepper } from '@/components/form/Stepper';
import {
  createFocusBlock,
  deleteFocusBlock,
  fetchFocusBlocks,
  fetchFocusPlan,
  fetchFocusSettings,
  reorderFocusBlocks,
  updateFocusBlock,
  updateFocusSettings,
} from '@/lib/client-api';
import {
  activeBlocks,
  currentWeek,
  endsIn,
  followOnBlock,
  localToday,
  newFocusBlock,
  nextMonthName,
  renewalPrompts,
  reorderedIds,
  shortDate,
  suggestedArea,
  upNext,
  withPriorities,
  type FocusWeekWorkout,
} from '@/lib/focusSetup';
import { logClientError } from '@/lib/log-client-error';
import FocusBlockCard, { AreaDot } from './FocusBlockCard';
import styles from './focus.module.css';

/** Blocks the user answered "Let it end" for, kept per browser. */
const DISMISSED_KEY = 'focus-work:let-it-end';

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage can be unavailable (private mode); the prompt just comes back next visit.
  }
}

type WeekPlans = { status: 'loading' } | { status: 'error' } | { status: 'ready'; plans: FocusDayPlanResponse[] };

interface Props {
  program: string;
  macrocycleNum: number | null;
  /** The program's lifts, by name. */
  programLifts: string[];
  /** Every workout of the current macrocycle; empty without one. */
  workouts: FocusWeekWorkout[];
  unit: WeightUnit;
}

/**
 * The focus work setup page (#1057), after the prototype's `focus-setup.jsx`.
 *
 * Every edit shows at once and saves in the background. Saves run one at a time, in the
 * order made, and once the last one finishes the page re-reads the focus blocks and this
 * week's plans, so it ends up showing what the API stored — including what the API does
 * on its own, like creating an auto-roll successor or declining one on Cancel.
 */
export default function FocusSetup({ program, macrocycleNum, programLifts, workouts, unit }: Props) {
  const [today, setToday] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<FocusBlock[] | null>(null);
  const [budget, setBudget] = useState<FocusBudget | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [week, setWeek] = useState<WeekPlans>({ status: 'loading' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [newArea, setNewArea] = useState<FocusArea | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);

  const weekWorkouts = today ? currentWeek(workouts, today) : [];
  const weekKey = weekWorkouts.map((workout) => workout.workoutNum).join(',');

  const loadWeek = useCallback(
    async (day: string, nums: number[]) => {
      if (nums.length === 0) {
        setWeek({ status: 'ready', plans: [] });
        return;
      }
      try {
        const plans = await Promise.all(nums.map((num) => fetchFocusPlan(program, num, day)));
        setWeek({ status: 'ready', plans });
      } catch (error) {
        logClientError('fetchFocusPlan', error, { program, workoutNums: nums });
        setWeek({ status: 'error' });
      }
    },
    [program],
  );

  const loadBlocks = useCallback(async (day: string) => {
    try {
      const [loaded, settings] = await Promise.all([fetchFocusBlocks(day), fetchFocusSettings()]);
      setBlocks(loaded);
      setBudget(settings);
      setLoadFailed(false);
    } catch (error) {
      logClientError('fetchFocusBlocks', error);
      setLoadFailed(true);
    }
  }, []);

  // The calendar day is the browser's, so it is read after mount, never on the server.
  useEffect(() => {
    setToday(localToday());
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    if (today) void loadBlocks(today);
  }, [today, loadBlocks]);

  useEffect(() => {
    if (!today) return;
    void loadWeek(
      today,
      weekKey ? weekKey.split(',').map(Number) : [],
    );
  }, [today, weekKey, loadWeek]);

  /** Runs a save after every earlier one; re-reads everything once none are left. */
  function save(operation: string, task: (day: string) => Promise<void>, context?: Record<string, unknown>) {
    if (!today) return;
    const day = today;
    pending.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        await task(day);
      } catch (error) {
        logClientError(operation, error, context);
        setSaveFailed(true);
      }
      pending.current -= 1;
      if (pending.current === 0) {
        await Promise.all([loadBlocks(day), loadWeek(day, weekKey ? weekKey.split(',').map(Number) : [])]);
      }
    });
  }

  function patchBlock(id: string, patch: UpdateFocusBlockRequest) {
    setBlocks((current) => current && current.map((block) => (block.id === id ? { ...block, ...patch } : block)));
    save('updateFocusBlock', (day) => updateFocusBlock(id, patch, day).then(() => undefined), {
      blockId: id,
      fields: Object.keys(patch),
    });
  }

  function createBlock(request: CreateFocusBlockRequest, open: boolean) {
    save(
      'createFocusBlock',
      async (day) => {
        const created = await createFocusBlock(request, day);
        setBlocks((current) => [...(current ?? []), created]);
        if (open) setOpenId(created.id);
      },
      { area: request.area },
    );
  }

  function removeBlock(id: string) {
    setBlocks((current) => current && current.filter((block) => block.id !== id));
    save('deleteFocusBlock', () => deleteFocusBlock(id), { blockId: id });
  }

  function moveBlock(id: string, delta: -1 | 1) {
    if (!blocks || !today) return;
    const ids = reorderedIds(blocks, today, id, delta);
    if (!ids) return;
    setBlocks(withPriorities(blocks, ids));
    save('reorderFocusBlocks', (day) => reorderFocusBlocks(ids, day).then(() => undefined), { blockId: id });
  }

  function setGuide(next: FocusBudget) {
    setBudget(next);
    save('updateFocusSettings', () => updateFocusSettings(next).then(() => undefined));
  }

  function letItEnd(id: string) {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    writeDismissed(next);
  }

  const crumb = (
    <ol className={styles.crumb}>
      <li>
        <Link href="/programs">Programs</Link>
      </li>
      <li>{macrocycleNum ? <Link href={`/macrocycle/${macrocycleNum}/program`}>{program}</Link> : program}</li>
    </ol>
  );

  const header = (
    <>
      <nav aria-label="Breadcrumb">{crumb}</nav>
      <h1 className={styles.title}>Focus work</h1>
      <p className={styles.sub}>
        Extra work added to every workout for a month or quarter, on a calendar separate from the program.
      </p>
    </>
  );

  if (!today || (!blocks && !loadFailed)) {
    return (
      <main className={styles.container}>
        {header}
        <p className={styles.muted}>Loading focus blocks…</p>
      </main>
    );
  }

  if (!blocks || !budget) {
    return (
      <main className={styles.container}>
        {header}
        <p className={styles.alert} role="alert">
          Couldn’t load your focus blocks.{' '}
          <button type="button" className={styles.linkBtn} onClick={() => void loadBlocks(today)}>
            Try again
          </button>
        </p>
      </main>
    );
  }

  const active = activeBlocks(blocks, today);
  const queued = upNext(blocks, today);
  const prompts = renewalPrompts(blocks, today, dismissed);
  const addArea = newArea ?? suggestedArea(blocks, today);

  const plans = week.status === 'ready' ? week.plans : null;
  /** This week's planned lifts that train a block's area, from the API's own overlap check. */
  const detectedFor = (id: string): string[] | null =>
    plans &&
    [
      ...new Set(
        plans.flatMap((plan) =>
          plan.groups.filter((group) => group.block.id === id).flatMap((group) => group.overlap?.lifts ?? []),
        ),
      ),
    ];

  return (
    <main className={styles.container}>
      {header}

      {saveFailed && (
        <p className={styles.alert} role="alert">
          A change didn’t save, so the page now shows what was saved.{' '}
          <button type="button" className={styles.linkBtn} onClick={() => setSaveFailed(false)}>
            Dismiss
          </button>
        </p>
      )}

      {prompts.map((block) => (
        <RenewPrompt
          key={block.id}
          block={block}
          today={today}
          onQueue={(area) => createBlock(followOnBlock(block, area), false)}
          onLetItEnd={() => letItEnd(block.id)}
        />
      ))}

      <h2 className={styles.sectionTitle}>Active focus blocks · by priority</h2>
      {active.length === 0 ?
        <p className={styles.muted}>No focus blocks are running. Add one below.</p>
      : <ul className={styles.blockList}>
          {active.map((block, index) => (
            <FocusBlockCard
              key={block.id}
              block={block}
              open={openId === block.id}
              first={index === 0}
              last={index === active.length - 1}
              detected={detectedFor(block.id)}
              programLifts={programLifts}
              unit={unit}
              onToggle={() => setOpenId(openId === block.id ? null : block.id)}
              onMove={(delta) => moveBlock(block.id, delta)}
              onPatch={(patch) => patchBlock(block.id, patch)}
              onRemove={() => removeBlock(block.id)}
            />
          ))}
        </ul>
      }
      <div className={`${styles.row} ${styles.addRow}`}>
        <Select<FocusArea> label="Area for a new focus block" value={addArea} options={FOCUS_AREAS} onChange={setNewArea} />
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary} focus-ring`}
          onClick={() => createBlock(newFocusBlock(addArea, today), true)}
        >
          + Add focus block
        </button>
      </div>

      {queued.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>Up next</h2>
          <ul className={`${styles.card} ${styles.plainList}`}>
            {queued.map(({ block, rolledFrom }) => (
              <li key={block.id} className={styles.plainRow}>
                <AreaDot area={block.area} />
                <span className={styles.blockName}>{block.area}</span>
                <span className={styles.blockMeta}>
                  {rangeLabel(block)} · {rolledFrom ? `auto-roll from ${rolledFrom.area}` : 'queued'}
                </span>
                <button
                  type="button"
                  className={`${styles.linkBtn} focus-ring`}
                  aria-label={`Cancel ${block.area} (${rangeLabel(block)})`}
                  onClick={() => removeBlock(block.id)}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2 className={styles.sectionTitle}>Daily focus guide</h2>
      <div className={styles.card}>
        <Field label="Extra sets per day" hint="Advisory. Going over suggests a trim; nothing is blocked.">
          <Stepper
            name="Extra sets per day"
            value={budget.sets}
            min={1}
            max={100}
            onChange={(sets) => setGuide({ ...budget, sets })}
          />
        </Field>
        <Field label="Focus time per day">
          <Stepper
            name="Focus time per day"
            value={budget.minutes}
            step={5}
            min={5}
            max={600}
            format={(minutes) => `${minutes} min`}
            onChange={(minutes) => setGuide({ ...budget, minutes })}
          />
        </Field>
      </div>

      <h2 className={styles.sectionTitle}>This week</h2>
      <ThisWeek workouts={weekWorkouts} week={week} />
    </main>
  );
}

function RenewPrompt({
  block,
  today,
  onQueue,
  onLetItEnd,
}: {
  block: FocusBlock;
  today: string;
  onQueue: (area: FocusArea) => void;
  onLetItEnd: () => void;
}) {
  const others = FOCUS_AREAS.filter((area) => area !== block.area);
  const [pick, setPick] = useState<FocusArea>(
    block.nextArea && block.nextArea !== block.area ? block.nextArea : (others[0] ?? block.area),
  );
  return (
    <section className={styles.prompt} aria-label={`${block.area} focus block ending`}>
      <p className={styles.promptTitle}>
        <AreaDot area={block.area} />
        {block.area} ({rangeLabel(block)}) ends {endsIn(daysLeft(block, today))}
      </p>
      <p className={styles.promptBody}>Choose what follows. A summary of volume and PRs appears when it ends.</p>
      <div className={styles.row}>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary} focus-ring`} onClick={() => onQueue(block.area)}>
          Renew for {block.period === 'quarterly' ? 'next quarter' : nextMonthName(block)}
        </button>
        <Select<FocusArea> label={`Area to follow ${block.area}`} value={pick} options={others} onChange={setPick} />
        <button type="button" className={`${styles.btn} focus-ring`} onClick={() => onQueue(pick)}>
          Queue
        </button>
        <button type="button" className={`${styles.btn} ${styles.btnGhost} focus-ring`} onClick={onLetItEnd}>
          Let it end
        </button>
      </div>
    </section>
  );
}

function ThisWeek({ workouts, week }: { workouts: FocusWeekWorkout[]; week: WeekPlans }) {
  if (workouts.length === 0) {
    return <p className={styles.muted}>Start a program to see focus work by workout.</p>;
  }
  if (week.status === 'loading') return <p className={styles.muted}>Loading this week…</p>;
  if (week.status === 'error') {
    return (
      <p className={styles.alert} role="alert">
        Couldn’t load this week’s focus work.
      </p>
    );
  }
  const overCount = week.plans.filter((plan) => plan.over).length;
  return (
    <div className={styles.card}>
      <p className={styles.weekHead}>
        {overCount > 0 ?
          `${overCount} of ${week.plans.length} workouts over the guide`
        : 'Every workout fits the guide'}
      </p>
      {week.plans.map((plan) => {
        const workout = workouts.find((w) => w.workoutNum === plan.workoutNum);
        const lifts = plan.groups.flatMap((group) => group.items.map((item) => item.lift));
        return (
          <div key={plan.workoutNum} className={styles.weekRow}>
            <span>{workout ? shortDate(workout.date) : `Workout ${plan.workoutNum}`}</span>
            <span className={styles.weekLifts}>{lifts.length > 0 ? lifts.join(', ') : '—'}</span>
            <span className={`${styles.weekNum} ${plan.over ? styles.warnText : ''}`}>
              {plan.sets} sets · {Math.round(plan.seconds / 60)} min
            </span>
          </div>
        );
      })}
    </div>
  );
}
