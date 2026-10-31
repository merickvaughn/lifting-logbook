'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { daysLeft, defaultFocusPool, rangeLabel } from '@lifting-logbook/core';
import {
  FOCUS_AREAS,
  FOCUS_LIMITS,
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
  anchoredPatch,
  autoRollSuccessor,
  currentWeek,
  endsIn,
  followOnBlock,
  localToday,
  newFocusBlock,
  nextMonthName,
  renewalPrompts,
  reorderedIds,
  shiftedFollowOn,
  shortDate,
  suggestedArea,
  upNext,
  withPriorities,
  type FocusWeekWorkout,
} from '@/lib/focusSetup';
import { logClientError } from '@/lib/log-client-error';
import FocusBlockCard, { AreaDot, focusBlockCardId } from './FocusBlockCard';
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

/** What a save can change, and so what to re-read once the saves are done. */
interface Reread {
  blocks: boolean;
  week: boolean;
  guide: boolean;
}
const NOTHING: Reread = { blocks: false, week: false, guide: false };
const EVERYTHING: Reread = { blocks: true, week: true, guide: true };
const BLOCKS_AND_WEEK: Reread = { blocks: true, week: true, guide: false };

interface Props {
  program: string;
  macrocycleNum: number | null;
  /** The program's lifts, by name. */
  programLifts: string[];
  /** Every workout of the current macrocycle; empty without one. */
  workouts: FocusWeekWorkout[];
  unit: WeightUnit;
  /** The focus block named by `?block=`, opened once the blocks load (#1078). */
  requestedBlock?: string;
}

/**
 * The focus work setup page (#1057), after the prototype's `focus-setup.jsx`.
 *
 * Every edit shows at once and saves in the background. Saves run one at a time, in the
 * order made, and once the last one finishes the page re-reads the focus blocks and this
 * week's plans, so it ends up showing what the API stored — including what the API does
 * on its own, like creating an auto-roll successor or declining one on Cancel.
 */
export default function FocusSetup({ program, macrocycleNum, programLifts, workouts, unit, requestedBlock }: Props) {
  const [today, setToday] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<FocusBlock[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [budget, setBudget] = useState<FocusBudget | null>(null);
  const [guideFailed, setGuideFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [week, setWeek] = useState<WeekPlans>({ status: 'loading' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [newArea, setNewArea] = useState<FocusArea | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  /** Creates still in flight: the buttons that create are disabled until they land. */
  const [creating, setCreating] = useState(0);
  /** Renewal prompts already answered, hidden until the re-read shows what was queued. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());

  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  /** Bumped by every save, so a re-read that started before it never overwrites its edit. */
  const generation = useRef(0);
  const weekRequest = useRef(0);
  /** What the saves since the last re-read can have changed. */
  const stale = useRef<Reread>({ ...NOTHING });
  const failedSinceReread = useRef(false);
  /** Follow-on blocks this page created, which are never mistaken for auto-roll successors. */
  const queuedHere = useRef(new Set<string>());
  /** The `?block=` focus block, until the first load of the blocks has opened it. */
  const arrival = useRef(requestedBlock);

  const weekWorkouts = today ? currentWeek(workouts, today) : [];
  const weekKey = weekWorkouts.map((workout) => workout.workoutNum).join(',');
  const weekNums = useCallback(() => (weekKey ? weekKey.split(',').map(Number) : []), [weekKey]);

  /** Reads this week's plans. Only the latest request's answer is shown. */
  const loadWeek = useCallback(
    async (day: string, current: () => boolean = () => true) => {
      const request = ++weekRequest.current;
      const nums = weekNums();
      const applies = () => request === weekRequest.current && current();
      if (nums.length === 0) {
        setWeek({ status: 'ready', plans: [] });
        return true;
      }
      try {
        const plans = await Promise.all(nums.map((num) => fetchFocusPlan(program, num, day)));
        if (applies()) setWeek({ status: 'ready', plans });
        return true;
      } catch (error) {
        logClientError('fetchFocusPlan', error, { program, workoutNums: nums });
        if (applies()) setWeek({ status: 'error' });
        return false;
      }
    },
    [program, weekNums],
  );

  /** Reads the focus blocks; true when they loaded. Applied only while `current()` holds. */
  const loadBlocks = useCallback(async (day: string, current: () => boolean = () => true) => {
    try {
      const loaded = await fetchFocusBlocks(day);
      if (current()) {
        setBlocks(loaded);
        setLoadFailed(false);
      }
      return true;
    } catch (error) {
      logClientError('fetchFocusBlocks', error);
      if (current()) setLoadFailed(true);
      return false;
    }
  }, []);

  /** Reads the daily focus guide. A failure here only affects the guide's own card. */
  const loadGuide = useCallback(async (current: () => boolean = () => true) => {
    try {
      const settings = await fetchFocusSettings();
      if (current()) {
        setBudget(settings);
        setGuideFailed(false);
      }
      return true;
    } catch (error) {
      logClientError('fetchFocusSettings', error);
      if (current()) setGuideFailed(true);
      return false;
    }
  }, []);

  // The calendar day is the browser's, so it is read after mount, never on the server.
  useEffect(() => {
    setToday(localToday());
    setDismissed(readDismissed());
  }, []);

  useEffect(() => {
    if (!today) return;
    void loadBlocks(today);
    void loadGuide();
  }, [today, loadBlocks, loadGuide]);

  useEffect(() => {
    if (today) void loadWeek(today);
  }, [today, loadWeek]);

  // Opens the focus block a link named (the calendar's "Edit in Programs"), once. Only an
  // active block has a card; an unknown, queued or ended id leaves the page as it is.
  useEffect(() => {
    const id = arrival.current;
    if (!id || !blocks || !today) return;
    arrival.current = undefined;
    if (!activeBlocks(blocks, today).some((block) => block.id === id)) return;
    setOpenId(id);
    document.getElementById(focusBlockCardId(id))?.scrollIntoView({ block: 'start' });
  }, [blocks, today]);

  /**
   * Runs a save after every earlier one. Once none are left, re-reads what the saves can
   * have changed (everything, after a failure), unless another save arrived meanwhile:
   * that one re-reads when it finishes, and an older answer would undo its edit.
   */
  function save(operation: string, task: (day: string) => Promise<void>, rereads: Reread, context?: Record<string, unknown>) {
    if (!today) return;
    const day = today;
    generation.current += 1;
    pending.current += 1;
    stale.current = {
      blocks: stale.current.blocks || rereads.blocks,
      week: stale.current.week || rereads.week,
      guide: stale.current.guide || rereads.guide,
    };
    queue.current = queue.current.then(async () => {
      try {
        await task(day);
      } catch (error) {
        logClientError(operation, error, context);
        failedSinceReread.current = true;
        stale.current = { ...EVERYTHING };
      }
      pending.current -= 1;
      if (pending.current > 0) return;

      const needs = stale.current;
      stale.current = { ...NOTHING };
      const startedAt = generation.current;
      const current = () => generation.current === startedAt;
      const [blocksRead] = await Promise.all([
        needs.blocks ? loadBlocks(day, current) : true,
        needs.week ? loadWeek(day, current) : true,
        needs.guide ? loadGuide(current) : true,
      ]);
      if (!current()) {
        // Discarded for a newer save: hand what this re-read was for to that save's.
        stale.current = {
          blocks: stale.current.blocks || needs.blocks,
          week: stale.current.week || needs.week,
          guide: stale.current.guide || needs.guide,
        };
        return;
      }
      setAnswered(new Set());
      // Claimed only once the blocks on screen really are what the API stored. A failed
      // blocks re-read shows its own alert; a failed week or guide re-read shows in its
      // own section.
      if (failedSinceReread.current && blocksRead) setSaveFailed(true);
      failedSinceReread.current = false;
    });
  }

  function patchBlock(id: string, patch: UpdateFocusBlockRequest) {
    const before = blocks?.find((block) => block.id === id);
    if (!blocks || !before || !today) return;
    const full = anchoredPatch(before, patch, today);
    const after = { ...before, ...full };
    const shift = shiftedFollowOn(blocks, before, after, today);
    // The API gives an active auto-roll block its successor on the next read, so a new
    // next area goes to that successor too, and going back to prompt removes it.
    // A block this page queued itself (a renewal, or a queued area) is never treated as one.
    const found = autoRollSuccessor(blocks, before, today);
    const successor = found && !queuedHere.current.has(found.id) ? found : undefined;
    const dropSuccessor = successor && full.onEnd === 'prompt' ? successor : undefined;
    const retarget =
      successor && !dropSuccessor && full.nextArea && full.nextArea !== successor.area ?
        { id: successor.id, patch: { area: full.nextArea, pool: defaultFocusPool(full.nextArea) } }
      : undefined;
    const shifted = shift && shift.id !== dropSuccessor?.id ? shift : null;

    setBlocks(
      (current) =>
        current &&
        current.flatMap((block) => {
          if (block.id === id) return [after];
          if (block.id === dropSuccessor?.id) return [];
          let next = block;
          if (block.id === shifted?.id) next = { ...next, start: shifted.start };
          if (block.id === retarget?.id) next = { ...next, ...retarget.patch };
          return [next];
        }),
    );
    const update = (blockId: string, body: UpdateFocusBlockRequest) =>
      save('updateFocusBlock', (day) => updateFocusBlock(blockId, body, day).then(() => undefined), BLOCKS_AND_WEEK, {
        blockId,
        fields: Object.keys(body),
      });
    // Start dates are unique within a series, so a follow-on moving later moves first, out
    // of the way of the block's new range; one moving earlier waits for the block.
    const followOnFirst = shifted && shifted.start > (blocks.find((b) => b.id === shifted.id)?.start ?? '');
    if (shifted && followOnFirst) update(shifted.id, { start: shifted.start });
    update(id, full);
    if (shifted && !followOnFirst) update(shifted.id, { start: shifted.start });
    if (retarget) update(retarget.id, retarget.patch);
    if (dropSuccessor) {
      save('deleteFocusBlock', () => deleteFocusBlock(dropSuccessor.id), BLOCKS_AND_WEEK, { blockId: dropSuccessor.id });
    }
  }

  function createBlock(request: CreateFocusBlockRequest, open: boolean) {
    setCreating((count) => count + 1);
    save(
      'createFocusBlock',
      async (day) => {
        try {
          const created = await createFocusBlock(request, day);
          if (request.series) queuedHere.current.add(created.id);
          setBlocks((current) => [...(current ?? []), created]);
          if (open) setOpenId(created.id);
        } finally {
          setCreating((count) => count - 1);
        }
      },
      BLOCKS_AND_WEEK,
      { area: request.area },
    );
  }

  function removeBlock(id: string) {
    setBlocks((current) => current && current.filter((block) => block.id !== id));
    save('deleteFocusBlock', () => deleteFocusBlock(id), BLOCKS_AND_WEEK, { blockId: id });
  }

  function moveBlock(id: string, delta: -1 | 1) {
    if (!blocks || !today) return;
    const ids = reorderedIds(blocks, today, id, delta);
    if (!ids) return;
    setBlocks(withPriorities(blocks, ids));
    // The order is worked out again when the save runs, from the API's own blocks: a save
    // ahead of it in the queue (a create, or an auto-roll the API adds on read) changes
    // which blocks the reorder has to list.
    save(
      'reorderFocusBlocks',
      async (day) => {
        const latest = reorderedIds(await fetchFocusBlocks(day), day, id, delta);
        if (latest) await reorderFocusBlocks(latest, day);
      },
      BLOCKS_AND_WEEK,
      { blockId: id },
    );
  }

  function setGuide(next: FocusBudget) {
    setBudget(next);
    // The guide only changes this week's totals; the page already holds what it saved.
    save('updateFocusSettings', () => updateFocusSettings(next).then(() => undefined), { ...NOTHING, week: true });
  }

  function answer(block: FocusBlock, area: FocusArea) {
    setAnswered((current) => new Set(current).add(block.id));
    createBlock(followOnBlock(block, area), false);
  }

  function letItEnd(id: string) {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    writeDismissed(next);
  }

  /** A retry's answer applies only if no save was queued while it was in flight. */
  function sinceNow(): () => boolean {
    const startedAt = generation.current;
    return () => generation.current === startedAt;
  }

  function retryReload() {
    if (!today) return;
    const current = sinceNow();
    void loadBlocks(today, current);
    void loadWeek(today, current);
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

  if (!blocks) {
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
  const prompts = renewalPrompts(blocks, today, dismissed).filter((block) => !answered.has(block.id));
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

      {loadFailed ?
        <p className={styles.alert} role="alert">
          Couldn’t reload your focus blocks, so changes shown here may not have saved.{' '}
          <button type="button" className={styles.linkBtn} onClick={retryReload}>
            Try again
          </button>
        </p>
      : saveFailed && (
          <p className={styles.alert} role="alert">
            A change didn’t save, so the page now shows what was saved.{' '}
            <button type="button" className={styles.linkBtn} onClick={() => setSaveFailed(false)}>
              Dismiss
            </button>
          </p>
        )
      }

      {prompts.map((block) => (
        <RenewPrompt
          key={block.id}
          block={block}
          today={today}
          disabled={creating > 0}
          onQueue={(area) => answer(block, area)}
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
              today={today}
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
          disabled={creating > 0}
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
      {budget && guideFailed && (
        <p className={styles.alert} role="alert">
          Couldn’t reload your daily focus guide, so it may not show what was saved.{' '}
          <button type="button" className={styles.linkBtn} onClick={() => void loadGuide(sinceNow())}>
            Try again
          </button>
        </p>
      )}
      {budget ?
        <div className={styles.card}>
          <Field label="Extra sets per day" hint="Advisory. Going over suggests a trim; nothing is blocked.">
            <Stepper
              name="Extra sets per day"
              value={budget.sets}
              min={1}
              max={FOCUS_LIMITS.MAX_GUIDE_SETS}
              onChange={(sets) => setGuide({ ...budget, sets })}
            />
          </Field>
          <Field label="Focus time per day">
            <Stepper
              name="Focus time per day"
              value={budget.minutes}
              step={5}
              min={5}
              max={FOCUS_LIMITS.MAX_GUIDE_MINUTES}
              format={(minutes) => `${minutes} min`}
              onChange={(minutes) => setGuide({ ...budget, minutes })}
            />
          </Field>
        </div>
      : guideFailed ?
        <p className={styles.alert} role="alert">
          Couldn’t load your daily focus guide.{' '}
          <button type="button" className={styles.linkBtn} onClick={() => void loadGuide(sinceNow())}>
            Try again
          </button>
        </p>
      : <p className={styles.muted}>Loading…</p>}

      <h2 className={styles.sectionTitle}>This week</h2>
      <ThisWeek workouts={weekWorkouts} week={week} />
    </main>
  );
}

function RenewPrompt({
  block,
  today,
  disabled,
  onQueue,
  onLetItEnd,
}: {
  block: FocusBlock;
  today: string;
  /** While another create is in flight, so one click can't queue two blocks. */
  disabled: boolean;
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
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary} focus-ring`}
          disabled={disabled}
          onClick={() => onQueue(block.area)}
        >
          Renew for {block.period === 'quarterly' ? 'next quarter' : nextMonthName(block)}
        </button>
        <Select<FocusArea> label={`Area to follow ${block.area}`} value={pick} options={others} onChange={setPick} />
        <button type="button" className={`${styles.btn} focus-ring`} disabled={disabled} onClick={() => onQueue(pick)}>
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
