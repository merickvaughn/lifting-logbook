'use client';

import { useId, useRef, useState, useTransition, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  FOCUS_SELECTIONS,
  type FocusDayPlanResponse,
  type FocusDayState,
  type FocusPlacement,
  type FocusPlanGroupResponse,
  type FocusSelection,
  type WeightUnit,
} from '@lifting-logbook/types';
import { rangeLabel } from '@lifting-logbook/core';
import { saveFocusDayState } from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import {
  FOCUS_OVERLAP_DESCRIPTION,
  FOCUS_PROGRESSION_LABEL,
  FOCUS_SELECTION_LABEL,
  describePrescription,
  focusRowIds,
  interleavedOrder,
  moveRow,
  overlapNote,
  plannedRowIds,
  plannedSeconds,
  skipReason,
  timerHint,
  toMinutes,
  workoutOrder,
} from '@/lib/focusWorkout';
import CollapsibleLiftList, { type FocusLiftRow, type LiftDetail, type LiftListRow } from './CollapsibleLiftList';
import styles from './detail.module.css';

interface Props {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  week: number;
  unit: WeightUnit;
  liftDetails: LiftDetail[];
  plan: FocusDayPlanResponse;
}

const PLACEMENTS: readonly [FocusPlacement, string][] = [
  ['before', 'Before'],
  ['after', 'After'],
  ['interleave', 'Interleave'],
];

/** One focus block's lifts today, as list rows, without the area tag. */
function focusRows(
  group: FocusPlanGroupResponse,
  unit: WeightUnit,
  timerIndexById: ReadonlyMap<string, number>,
): FocusLiftRow[] {
  const { block } = group;
  const ids = focusRowIds(
    block.id,
    group.items.map((item) => item.lift),
  );
  return group.items.map((item, index) => {
    const rx = describePrescription(item.prescription, unit);
    const id = ids[index] ?? '';
    const timerIndex = timerIndexById.get(id);
    return {
      kind: 'focus',
      id,
      ...(timerIndex !== undefined && { timerIndex }),
      lift: item.lift,
      summary: rx.summary,
      groupLabel: `Focus sets · ${FOCUS_PROGRESSION_LABEL[block.progression]}`,
      sets: item.sets,
      perSet: rx.perSet,
      hint: `${rx.hint} ${timerHint(block.timer)}`,
      note: overlapNote(item, group),
      area: null,
    };
  });
}

/**
 * Focus work on the workout details page (#1058): the summary against the daily focus
 * guide, the over-guide advice, each focus block's choices for today, and where focus
 * work sits relative to the planned lifts.
 *
 * The plan is computed by the API from the saved day state, so a change that alters which
 * lifts run (a mode, a pick, a trim) is saved and the page refreshed. Placement, order and
 * "keep everything" only change the layout and apply at once; placement and order then
 * refresh too, because the timer queues lifts in that order (#1060).
 *
 * Each row's place in the timer queue comes from `plan.dayState`, the state the server
 * built the queue from, not the local state: until the refresh lands, a row reordered
 * here still starts the timer at its own sets in the queue as it stands.
 */
export default function FocusWorkout({ program, macrocycleNum, workoutNum, week, unit, liftDetails, plan }: Props) {
  const router = useRouter();
  const ids = useId();
  const [state, setState] = useState<FocusDayState>(plan.dayState);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(0);
  const [draggingModule, setDraggingModule] = useState<'planned' | 'focus' | null>(null);
  const placementRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Saves run one at a time, in the order they were made, each carrying the whole state
  // at that point. Only the latest one decides what the page shows when it settles: an
  // earlier failure is already folded into a later save, so it reverts nothing.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latestSave = useRef(0);
  // The last state the API accepted, which a failed latest save reverts to.
  const saved = useRef<FocusDayState>(plan.dayState);
  // Set by any change to which lifts run, or to the order the timer queues them in; the
  // page re-plans once the queue drains.
  const needsReplan = useRef(false);

  function save(next: FocusDayState, replan: boolean) {
    const seq = ++latestSave.current;
    if (replan) needsReplan.current = true;
    setState(next);
    setError(null);
    setSaving((n) => n + 1);
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        saved.current = await saveFocusDayState(program, workoutNum, next);
      } catch (e) {
        logClientError('saveFocusDayState', e, { program, macrocycleNum, workoutNum });
        if (seq === latestSave.current) {
          setState(saved.current);
          setError('Couldn’t save your focus work changes. Please try again.');
        }
      } finally {
        setSaving((n) => n - 1);
        if (seq === latestSave.current && needsReplan.current) {
          needsReplan.current = false;
          startTransition(() => router.refresh());
        }
      }
    });
  }

  // Controls that change which lifts run wait for the plan to catch up, so a second click
  // can't act on advice or chips the first one already changed.
  const busy = pending || saving > 0;

  const allPlannedSets = liftDetails.flatMap((d) => d.plannedSets);
  const plannedSetCount = allPlannedSets.length;
  const plannedSec = plannedSeconds(allPlannedSets);
  const { budget, groups, suggestion } = plan;
  // The same rule core's planFocusDay uses for `over`, so the colors agree with the advice.
  const overSets = plan.sets > budget.sets;
  const overMinutes = plan.seconds / 60 > budget.minutes;
  const trimmedLifts = groups.flatMap((group) => group.trimmed);
  const suggestionGroup = suggestion ? groups.find((g) => g.block.id === suggestion.blockId) : undefined;
  const timerIndexById = new Map(
    workoutOrder(
      liftDetails.map((d) => d.lift),
      groups,
      plan.dayState,
    ).map((entry, index) => [entry.id, index]),
  );
  const rowsByGroup = new Map(groups.map((group) => [group.block.id, focusRows(group, unit, timerIndexById)]));

  const plannedIds = plannedRowIds(liftDetails.map((d) => d.lift));
  const plannedRows: LiftListRow[] = plannedIds.map((id, liftIndex) => ({
    kind: 'planned',
    id,
    liftIndex,
    timerIndex: timerIndexById.get(id) ?? liftIndex,
  }));
  const interleave = state.placement === 'interleave';

  function setMode(blockId: string, mode: FocusSelection | undefined) {
    const modes = { ...state.modes };
    if (mode === undefined) delete modes[blockId];
    else modes[blockId] = mode;
    save({ ...state, modes }, true);
  }

  function togglePick(blockId: string, lift: string) {
    const current = state.picks[blockId] ?? [];
    const picks = current.includes(lift) ? current.filter((l) => l !== lift) : [...current, lift];
    save({ ...state, picks: { ...state.picks, [blockId]: picks } }, true);
  }

  function trimSuggestion() {
    if (!suggestion) return;
    const current = state.trims[suggestion.blockId] ?? [];
    if (current.includes(suggestion.lift)) return;
    save({ ...state, trims: { ...state.trims, [suggestion.blockId]: [...current, suggestion.lift] } }, true);
  }

  /** Arrow keys move through the placements, as in a native radio group. */
  function onPlacementKey(e: KeyboardEvent, index: number) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const nextIndex = (index + step + PLACEMENTS.length) % PLACEMENTS.length;
    const next = PLACEMENTS[nextIndex];
    if (!next) return;
    save({ ...state, placement: next[0] }, true);
    placementRefs.current[nextIndex]?.focus();
  }

  // Only the ⠿ grip starts a module drag, so a drag from a link, a control or selected
  // text inside the module can't flip the placement. `setData` lets the drag start in
  // Firefox.
  function moduleGrip(module: 'planned' | 'focus') {
    return (
      <span
        className={styles.grip}
        aria-hidden="true"
        title="Drag to move"
        draggable
        onDragStart={(e) => {
          setDraggingModule(module);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', module);
        }}
        onDragEnd={() => setDraggingModule(null)}
      >
        ⠿
      </span>
    );
  }

  function moduleDropProps(module: 'planned' | 'focus') {
    return {
      onDragOver: (e: DragEvent) => e.preventDefault(),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (draggingModule !== null && draggingModule !== module) {
          save({ ...state, placement: state.placement === 'before' ? 'after' : 'before' }, true);
        }
        setDraggingModule(null);
      },
    };
  }

  function groupControls(group: FocusPlanGroupResponse): ReactNode {
    const { block } = group;
    const override = state.modes[block.id] ?? '';
    const picks = state.picks[block.id] ?? [];
    return (
      <div className={styles.fgHead}>
        <div className={styles.fgTop}>
          <span className={styles.dot} data-area={block.area} aria-hidden="true" />
          <h3 className={styles.fgName}>{block.area}</h3>
          <span className={styles.fgMeta}>
            {rangeLabel(block)} · priority {block.priority}
          </span>
          <select
            className={styles.sel}
            aria-label={`${block.area} selection today`}
            value={override}
            disabled={busy}
            onChange={(e) => setMode(block.id, FOCUS_SELECTIONS.find((mode) => mode === e.target.value))}
          >
            <option value="">Focus block default ({FOCUS_SELECTION_LABEL[block.selection]})</option>
            {FOCUS_SELECTIONS.map((mode) => (
              <option key={mode} value={mode}>
                {FOCUS_SELECTION_LABEL[mode]} today
              </option>
            ))}
          </select>
        </div>
        {group.overlap && (
          <p className={styles.fgNote}>
            {group.overlap.lifts.join(' & ')} trains {block.area.toLowerCase()} today, so{' '}
            {FOCUS_OVERLAP_DESCRIPTION[group.overlap.mode]}.
          </p>
        )}
        {group.mode === 'pick' && (
          <div className={styles.pickRow}>
            <span className={styles.fieldHint}>Today:</span>
            {group.suggestions.map((entry, index) => {
              const on = picks.includes(entry.lift);
              return (
                <button
                  key={index}
                  type="button"
                  className={`${styles.chip} ${on ? styles.chipOn : ''} focus-ring`}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => togglePick(block.id, entry.lift)}
                >
                  {on ? '✓ ' : '+ '}
                  {entry.lift}
                </button>
              );
            })}
          </div>
        )}
        {group.skipped.map((skip, index) => (
          <p key={`s:${index}`} className={styles.skipRow}>
            <s>{skip.lift}</s> skipped: {skipReason(skip, block.area)}
          </p>
        ))}
        {group.trimmed.map((lift, index) => (
          <p key={`t:${index}`} className={styles.skipRow}>
            <s>{lift}</s> trimmed for today
          </p>
        ))}
      </div>
    );
  }

  const listProps = { liftDetails, macrocycleNum, workoutNum, unit };

  /** The heading's id is `${ids}-${key}`, which the module's `aria-labelledby` names. */
  function moduleHead(
    key: string,
    grip: 'planned' | 'focus' | null,
    title: string,
    sub: string | null,
    meta: ReactNode,
  ) {
    return (
      <div className={styles.moduleHead}>
        {grip !== null && moduleGrip(grip)}
        <div className={styles.moduleTitle}>
          <h2 id={`${ids}-${key}`} className={styles.moduleHeading}>
            {title}
          </h2>
          {sub !== null && <span className={styles.moduleSub}>{sub}</span>}
        </div>
        {meta}
      </div>
    );
  }

  const plannedModule = (
    <section
      key="planned"
      aria-labelledby={`${ids}-planned`}
      className={`${styles.module} ${draggingModule === 'planned' ? styles.moduleDragging : ''}`}
      {...moduleDropProps('planned')}
    >
      {moduleHead(
        'planned',
        'planned',
        'Planned',
        `Week ${week}`,
        <span className={styles.moduleMeta}>
          {plannedSetCount} sets · {toMinutes(plannedSec)} min
        </span>,
      )}
      <CollapsibleLiftList {...listProps} rows={plannedRows} />
    </section>
  );

  const focusModule = (
    <section
      key="focus"
      aria-labelledby={`${ids}-focus`}
      className={`${styles.module} ${draggingModule === 'focus' ? styles.moduleDragging : ''}`}
      {...moduleDropProps('focus')}
    >
      {moduleHead(
        'focus',
        'focus',
        'Focus work',
        'Independent of the program · own timer per focus block',
        <span className={styles.moduleMeta}>
          {plan.sets} sets · {toMinutes(plan.seconds)} min
        </span>,
      )}
      {groups.map((group) => {
        const rows = rowsByGroup.get(group.block.id) ?? [];
        return (
          <div key={group.block.id} className={styles.focusGroup}>
            {groupControls(group)}
            {rows.length > 0 && <CollapsibleLiftList {...listProps} rows={rows} />}
          </div>
        );
      })}
    </section>
  );

  function interleavedModules() {
    // Interleaved, a focus lift carries its area so it reads apart from planned lifts.
    const focus = groups.flatMap((group) =>
      (rowsByGroup.get(group.block.id) ?? []).map((row) => ({ ...row, area: group.block.area })),
    );
    const byId = new Map<string, LiftListRow>([...plannedRows, ...focus].map((row) => [row.id, row]));
    const order = interleavedOrder(
      plannedIds,
      focus.map((row) => row.id),
      state.order,
    );
    const rows = order.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    return (
      <>
        <section aria-labelledby={`${ids}-order`} className={styles.module}>
          {moduleHead(
            'order',
            null,
            'Today’s order',
            'Planned and focus lifts mixed; drag or use the arrows to reorder',
            state.order && (
              <button type="button" className={styles.linkBtn} onClick={() => save({ ...state, order: null }, true)}>
                Reset order
              </button>
            ),
          )}
          <CollapsibleLiftList
            {...listProps}
            rows={rows}
            reorder={{ onMove: (from, to) => save({ ...state, order: moveRow(order, from, to) }, true) }}
          />
        </section>
        <section aria-labelledby={`${ids}-controls`} className={styles.module}>
          {moduleHead('controls', null, 'Focus controls for today', null, null)}
          {groups.map((group) => (
            <div key={group.block.id} className={styles.focusGroup}>
              {groupControls(group)}
            </div>
          ))}
        </section>
      </>
    );
  }

  return (
    <div aria-busy={busy}>
      <section className={styles.summarySection}>
        <h2 className={styles.summaryTitle}>Workout Summary</h2>
        <div className={styles.summaryGrid}>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Planned</span>
            <span className={styles.summaryValue}>{plannedSetCount} sets</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Focus</span>
            <span className={`${styles.summaryValue} ${overSets ? styles.warnText : ''}`}>
              {plan.sets} sets <span className={styles.summaryOf}>/ {budget.sets} guide</span>
            </span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Estimated time</span>
            <span className={styles.summaryValue}>{toMinutes(plannedSec + plan.seconds)} min</span>
          </div>
          <div className={styles.summaryItem}>
            <span className={styles.summaryLabel}>Focus time</span>
            <span className={`${styles.summaryValue} ${overMinutes ? styles.warnText : ''}`}>
              {toMinutes(plan.seconds)} min <span className={styles.summaryOf}>/ {budget.minutes} guide</span>
            </span>
          </div>
        </div>
      </section>

      {plan.over && suggestion && suggestionGroup && !state.dismissed && (
        <div className={styles.advice} role="region" aria-label="Focus guide advice">
          <p className={styles.adviceTitle}>Over your daily focus guide</p>
          <p className={styles.adviceBody}>
            {plan.sets} of {budget.sets} sets, {toMinutes(plan.seconds)} of {budget.minutes} min.{' '}
            {suggestionGroup.block.area} is your lowest priority; trimming {suggestion.lift} brings today to{' '}
            {suggestion.sets} sets, {toMinutes(suggestion.seconds)} min.
          </p>
          <div className={styles.promptBtns}>
            <button
              type="button"
              className={`${styles.btnSm} ${styles.btnSmPrimary} focus-ring`}
              disabled={busy}
              onClick={trimSuggestion}
            >
              Trim {suggestion.lift}
            </button>
            <button
              type="button"
              className={`${styles.btnSm} ${styles.btnSmGhost} focus-ring`}
              onClick={() => save({ ...state, dismissed: true }, false)}
            >
              Keep everything
            </button>
          </div>
        </div>
      )}
      {plan.over && state.dismissed && (
        <p className={styles.quiet}>
          Over the guide; keeping everything.{' '}
          <button type="button" className={styles.linkBtn} onClick={() => save({ ...state, dismissed: false }, false)}>
            Show suggestion
          </button>
        </p>
      )}
      {trimmedLifts.length > 0 && (
        <p className={styles.quiet}>
          Trimmed today: {trimmedLifts.join(', ')}.{' '}
          <button
            type="button"
            className={styles.linkBtn}
            disabled={busy}
            onClick={() => save({ ...state, trims: {} }, true)}
          >
            Undo
          </button>
        </p>
      )}
      {error && (
        <p className={styles.focusError} role="alert">
          {error}
        </p>
      )}

      <div className={styles.field}>
        <div className={styles.fieldMeta}>
          <span className={styles.fieldLabel} id={`${ids}-placement`}>
            Focus work placement
          </span>
          <span className={styles.fieldHint}>Drag modules or lifts by ⠿, or use the arrows, to reorder</span>
        </div>
        <div className={styles.seg} role="radiogroup" aria-labelledby={`${ids}-placement`}>
          {PLACEMENTS.map(([value, label], index) => (
            <button
              key={value}
              ref={(el) => {
                placementRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={state.placement === value}
              tabIndex={state.placement === value ? 0 : -1}
              className={`${styles.segBtn} ${state.placement === value ? styles.segBtnOn : ''} focus-ring`}
              onClick={() => save({ ...state, placement: value }, true)}
              onKeyDown={(e) => onPlacementKey(e, index)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {interleave ?
        interleavedModules()
      : state.placement === 'before' ?
        [focusModule, plannedModule]
      : [plannedModule, focusModule]}

      <p className={styles.quiet}>
        Focus blocks are set up under <Link href="/programs">Programs</Link>.
      </p>
    </div>
  );
}
