'use client';

import { useRef, useState, useTransition, type DragEvent, type ReactNode } from 'react';
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
  focusAreaColor,
  focusRowId,
  interleavedOrder,
  moveRow,
  overlapNote,
  plannedRowIds,
  plannedSeconds,
  skipReason,
  timerHint,
  toMinutes,
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

function focusRows(group: FocusPlanGroupResponse, unit: WeightUnit, withArea: boolean): FocusLiftRow[] {
  const { block } = group;
  return group.items.map((item) => {
    const rx = describePrescription(item.prescription, unit);
    return {
      kind: 'focus',
      id: focusRowId(block.id, item.lift),
      lift: item.lift,
      summary: rx.summary,
      groupLabel: `Focus sets · ${FOCUS_PROGRESSION_LABEL[block.progression]}`,
      sets: item.sets,
      perSet: rx.perSet,
      hint: `${rx.hint} ${timerHint(block.timer)}`,
      note: overlapNote(item, group),
      area: withArea ? block.area : null,
    };
  });
}

/**
 * Focus work on the workout details page (#1058): the summary against the daily focus
 * guide, the over-guide advice, each focus block's choices for today, and where focus
 * work sits relative to the planned lifts.
 *
 * The plan is computed by the API from the saved day state, so a change that alters which
 * lifts run (a mode, a pick, a trim) is saved and the page refreshed; placement, order and
 * "keep everything" only change the layout and apply at once.
 */
export default function FocusWorkout({ program, macrocycleNum, workoutNum, week, unit, liftDetails, plan }: Props) {
  const router = useRouter();
  const [state, setState] = useState<FocusDayState>(plan.dayState);
  // The last state the API accepted, which a failed save reverts to.
  const saved = useRef<FocusDayState>(plan.dayState);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [draggingModule, setDraggingModule] = useState<'planned' | 'focus' | null>(null);

  async function save(next: FocusDayState, replan: boolean) {
    setState(next);
    setError(null);
    try {
      saved.current = await saveFocusDayState(program, workoutNum, next);
      if (replan) startTransition(() => router.refresh());
    } catch (e) {
      logClientError('saveFocusDayState', e, { program, macrocycleNum, workoutNum });
      setState(saved.current);
      setError('Couldn’t save your focus work changes. Please try again.');
    }
  }

  const allPlannedSets = liftDetails.flatMap((d) => d.plannedSets);
  const plannedSetCount = allPlannedSets.length;
  const plannedSec = plannedSeconds(allPlannedSets);
  const { budget, groups, suggestion } = plan;
  const overSets = plan.sets > budget.sets;
  const overMinutes = toMinutes(plan.seconds) > budget.minutes;
  const trimmedLifts = Object.values(state.trims).flat();
  const suggestionGroup = suggestion ? groups.find((g) => g.block.id === suggestion.blockId) : undefined;

  const plannedIds = plannedRowIds(liftDetails.map((d) => d.lift));
  const plannedRows: LiftListRow[] = plannedIds.map((id, liftIndex) => ({ kind: 'planned', id, liftIndex }));
  const interleave = state.placement === 'interleave';
  const allFocusRows = groups.flatMap((group) => focusRows(group, unit, interleave));
  const byId = new Map<string, LiftListRow>([...plannedRows, ...allFocusRows].map((row) => [row.id, row]));
  const mixedIds = interleavedOrder(
    plannedIds,
    allFocusRows.map((row) => row.id),
    state.order,
  );
  const mixedRows = mixedIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });

  /** Saves a change to which lifts run today, then re-plans the day. */
  function replan(change: (draft: FocusDayState) => void) {
    const next: FocusDayState = {
      ...state,
      modes: { ...state.modes },
      picks: { ...state.picks },
      trims: { ...state.trims },
    };
    change(next);
    void save(next, true);
  }

  function setMode(blockId: string, mode: FocusSelection | undefined) {
    replan((draft) => {
      if (mode === undefined) delete draft.modes[blockId];
      else draft.modes[blockId] = mode;
    });
  }

  function togglePick(blockId: string, lift: string) {
    replan((draft) => {
      const current = draft.picks[blockId] ?? [];
      draft.picks[blockId] = current.includes(lift) ? current.filter((l) => l !== lift) : [...current, lift];
    });
  }

  function trimSuggestion() {
    if (!suggestion) return;
    const current = state.trims[suggestion.blockId] ?? [];
    void save({ ...state, trims: { ...state.trims, [suggestion.blockId]: [...current, suggestion.lift] } }, true);
  }

  function moduleDragProps(module: 'planned' | 'focus') {
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        setDraggingModule(module);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => setDraggingModule(null),
      onDragOver: (e: DragEvent) => e.preventDefault(),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (draggingModule !== null && draggingModule !== module) {
          void save({ ...state, placement: state.placement === 'before' ? 'after' : 'before' }, false);
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
          <span className={styles.dot} style={{ background: focusAreaColor(block.area) }} aria-hidden="true" />
          <h3 className={styles.fgName}>{block.area}</h3>
          <span className={styles.fgMeta}>
            {rangeLabel(block)} · priority {block.priority}
          </span>
          <select
            className={styles.sel}
            aria-label={`${block.area} selection today`}
            value={override}
            disabled={pending}
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
            {group.suggestions.map((entry) => {
              const on = picks.includes(entry.lift);
              return (
                <button
                  key={entry.lift}
                  type="button"
                  className={`${styles.chip} ${on ? styles.chipOn : ''} focus-ring`}
                  aria-pressed={on}
                  disabled={pending}
                  onClick={() => togglePick(block.id, entry.lift)}
                >
                  {on ? '✓ ' : '+ '}
                  {entry.lift}
                </button>
              );
            })}
          </div>
        )}
        {group.skipped.map((skip) => (
          <p key={`s:${skip.lift}`} className={styles.skipRow}>
            <s>{skip.lift}</s> skipped: {skipReason(skip, block.area)}
          </p>
        ))}
        {group.trimmed.map((lift) => (
          <p key={`t:${lift}`} className={styles.skipRow}>
            <s>{lift}</s> trimmed for today
          </p>
        ))}
      </div>
    );
  }

  const listProps = { liftDetails, macrocycleNum, workoutNum, unit };

  const plannedModule = (
    <section
      key="planned"
      aria-labelledby="planned-module-title"
      className={`${styles.module} ${draggingModule === 'planned' ? styles.moduleDragging : ''}`}
      {...moduleDragProps('planned')}
    >
      <div className={styles.moduleHead}>
        <span className={styles.grip} aria-hidden="true" title="Drag to move">
          ⠿
        </span>
        <div className={styles.moduleTitle}>
          <h2 id="planned-module-title" className={styles.moduleHeading}>
            Planned
          </h2>
          <span className={styles.moduleSub}>Week {week}</span>
        </div>
        <span className={styles.moduleMeta}>
          {plannedSetCount} sets · {toMinutes(plannedSec)} min
        </span>
      </div>
      <CollapsibleLiftList {...listProps} rows={plannedRows} />
    </section>
  );

  const focusModule = (
    <section
      key="focus"
      aria-labelledby="focus-module-title"
      className={`${styles.module} ${draggingModule === 'focus' ? styles.moduleDragging : ''}`}
      {...moduleDragProps('focus')}
    >
      <div className={styles.moduleHead}>
        <span className={styles.grip} aria-hidden="true" title="Drag to move">
          ⠿
        </span>
        <div className={styles.moduleTitle}>
          <h2 id="focus-module-title" className={styles.moduleHeading}>
            Focus work
          </h2>
          <span className={styles.moduleSub}>Independent of the program · own timer per focus block</span>
        </div>
        <span className={styles.moduleMeta}>
          {plan.sets} sets · {toMinutes(plan.seconds)} min
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.block.id} className={styles.focusGroup}>
          {groupControls(group)}
          {group.items.length > 0 && <CollapsibleLiftList {...listProps} rows={focusRows(group, unit, false)} />}
        </div>
      ))}
    </section>
  );

  return (
    <div aria-busy={pending}>
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
              disabled={pending}
              onClick={trimSuggestion}
            >
              Trim {suggestion.lift}
            </button>
            <button
              type="button"
              className={`${styles.btnSm} ${styles.btnSmGhost} focus-ring`}
              onClick={() => void save({ ...state, dismissed: true }, false)}
            >
              Keep everything
            </button>
          </div>
        </div>
      )}
      {plan.over && state.dismissed && (
        <p className={styles.quiet}>
          Over the guide; keeping everything.{' '}
          <button type="button" className={styles.linkBtn} onClick={() => void save({ ...state, dismissed: false }, false)}>
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
            disabled={pending}
            onClick={() => void save({ ...state, trims: {} }, true)}
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
          <span className={styles.fieldLabel} id="focus-placement-label">
            Focus work placement
          </span>
          <span className={styles.fieldHint}>Drag modules or lifts by ⠿, or use the arrows, to reorder</span>
        </div>
        <div className={styles.seg} role="radiogroup" aria-labelledby="focus-placement-label">
          {PLACEMENTS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={state.placement === value}
              className={`${styles.segBtn} ${state.placement === value ? styles.segBtnOn : ''} focus-ring`}
              onClick={() => void save({ ...state, placement: value }, false)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {interleave ?
        <>
          <section aria-labelledby="order-module-title" className={styles.module}>
            <div className={styles.moduleHead}>
              <div className={styles.moduleTitle}>
                <h2 id="order-module-title" className={styles.moduleHeading}>
                  Today’s order
                </h2>
                <span className={styles.moduleSub}>Planned and focus lifts mixed; drag or use the arrows to reorder</span>
              </div>
              {state.order && (
                <button type="button" className={styles.linkBtn} onClick={() => void save({ ...state, order: null }, false)}>
                  Reset order
                </button>
              )}
            </div>
            <CollapsibleLiftList
              {...listProps}
              rows={mixedRows}
              reorder={{ onMove: (from, to) => void save({ ...state, order: moveRow(mixedIds, from, to) }, false) }}
            />
          </section>
          <section aria-labelledby="controls-module-title" className={styles.module}>
            <div className={styles.moduleHead}>
              <div className={styles.moduleTitle}>
                <h2 id="controls-module-title" className={styles.moduleHeading}>
                  Focus controls for today
                </h2>
              </div>
            </div>
            {groups.map((group) => (
              <div key={group.block.id} className={styles.focusGroup}>
                {groupControls(group)}
              </div>
            ))}
          </section>
        </>
      : state.placement === 'before' ?
        [focusModule, plannedModule]
      : [plannedModule, focusModule]}

      <p className={styles.quiet}>
        Focus blocks are set up under <Link href="/programs">Programs</Link>.
      </p>
    </div>
  );
}
