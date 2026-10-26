'use client';

import { useState } from 'react';
import {
  FOCUS_AREA_MUSCLES,
  FOCUS_AREAS,
  FOCUS_LIMITS,
  FOCUS_OVERLAPS,
  FOCUS_PROGRESSIONS,
  FOCUS_SELECTIONS,
  type FocusArea,
  type FocusBlock,
  type FocusPoolEntry,
  type UpdateFocusBlockRequest,
  type WeightUnit,
} from '@lifting-logbook/types';
import {
  LIFT_CATALOG,
  blockRange,
  defaultFocusPool,
  defaultPoolEntry,
  formatDuration,
  rangeLabel,
} from '@lifting-logbook/core';
import { Field } from '@/components/form/Field';
import { Seg } from '@/components/form/Seg';
import { Select } from '@/components/form/Select';
import { Stepper } from '@/components/form/Stepper';
import {
  OVERLAP_LABELS,
  PROGRESSION_LABELS,
  SELECTION_HINTS,
  SELECTION_LABELS,
  isUsableStart,
  runLabel,
} from '@/lib/focusSetup';
import FocusPoolRow from './FocusPoolRow';
import styles from './focus.module.css';

const { MAX_POOL, MAX_TIMER_SEC } = FOCUS_LIMITS;

/** The dot in an area's colour. */
export function AreaDot({ area }: { area: FocusArea }) {
  return <span className={`${styles.dot} ${styles[`area${area}`]}`} aria-hidden="true" />;
}

/**
 * The "+ Add lift…" choices: catalog lifts not in the pool, those training the area first.
 * The value is the lift's name; the empty value is the placeholder.
 */
function addLiftOptions(block: FocusBlock): (readonly [string, string])[] {
  const groups: readonly string[] = FOCUS_AREA_MUSCLES[block.area];
  const available = LIFT_CATALOG.filter((lift) => !block.pool.some((entry) => entry.lift === lift.name));
  const near = available.filter((lift) => lift.muscles.primary.some((muscle) => groups.includes(muscle)));
  const rest = available.filter((lift) => !near.includes(lift));
  return [
    ['', '+ Add lift…'],
    ...near.map((lift) => [lift.name, `${lift.name} · ${block.area}`] as const),
    ...rest.map((lift) => [lift.name, lift.name] as const),
  ];
}

/** One active focus block: its header with priority controls, and its editor when open. */
export default function FocusBlockCard({
  block,
  today,
  open,
  first,
  last,
  detected,
  programLifts,
  unit,
  onToggle,
  onMove,
  onPatch,
  onRemove,
}: {
  block: FocusBlock;
  today: string;
  open: boolean;
  first: boolean;
  last: boolean;
  /** This week's planned lifts that train the area, or null while unknown. */
  detected: readonly string[] | null;
  programLifts: readonly string[];
  unit: WeightUnit;
  onToggle: () => void;
  onMove: (delta: -1 | 1) => void;
  onPatch: (patch: UpdateFocusBlockRequest) => void;
  onRemove: () => void;
}) {
  const { area } = block;
  const range = blockRange(block);
  const bodyId = `focus-block-${block.id}`;
  const areaWord = area.toLowerCase();
  const unitLabel = block.period === 'quarterly' ? 'quarter' : 'month';

  const [startDraft, setStartDraft] = useState<string | null>(null);
  function commitStart() {
    if (startDraft !== null && startDraft !== block.start && isUsableStart(block, startDraft, today)) {
      onPatch({ start: startDraft });
    }
    setStartDraft(null);
  }

  const setPool = (pool: FocusPoolEntry[]) => onPatch({ pool });
  const setTimer = (key: keyof FocusBlock['timer'], value: number) =>
    onPatch({ timer: { ...block.timer, [key]: value } });

  let overlapHint = 'Per-lift rules below also apply.';
  if (detected) {
    overlapHint =
      (detected.length > 0 ?
        `This week, ${detected.join(', ')} train ${areaWord}.`
      : `No lift planned this week has ${areaWord} as a primary mover.`) + ` ${overlapHint}`;
  }

  return (
    <li className={styles.blockCard}>
      <div className={styles.blockHead}>
        <button
          type="button"
          className={`${styles.blockToggle} focus-ring`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className={`${styles.toggleIcon} ${open ? styles.toggleIconOpen : ''}`} aria-hidden="true">
            ›
          </span>
          <AreaDot area={area} />
          <span className={styles.blockName}>{area}</span>
          <span className={styles.blockMeta}>
            {block.period === 'quarterly' ? 'Quarterly' : 'Monthly'} · {rangeLabel(block)}
          </span>
        </button>
        <span className={styles.priority}>
          <span>P{block.priority}</span>
          <button
            type="button"
            className={`${styles.prioBtn} focus-ring`}
            aria-label={`Raise priority of ${area}`}
            disabled={first}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={`${styles.prioBtn} focus-ring`}
            aria-label={`Lower priority of ${area}`}
            disabled={last}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </span>
      </div>

      <div id={bodyId} className={styles.blockBody} hidden={!open}>
        {open && (
          <>
            <Field label="Area">
              <Select<FocusArea>
                label="Area"
                value={area}
                options={FOCUS_AREAS}
                // A new area needs new lifts.
                onChange={(next) => onPatch({ area: next, pool: defaultFocusPool(next) })}
              />
            </Field>
            <Field label="Period" hint={`Runs ${runLabel(range.start, range.end)}`}>
              <Seg
                label="Period"
                options={[
                  ['quarterly', 'Quarterly'],
                  ['monthly', 'Monthly'],
                ]}
                value={block.period}
                onChange={(period) => onPatch({ period })}
              />
            </Field>
            <Field
              label="Starts"
              hint={
                block.align === 'calendar' ?
                  `Aligned to calendar ${unitLabel}s`
                : `Runs one ${unitLabel} from this date`
              }
            >
              <div className={styles.row}>
                <Seg
                  label="Starts"
                  options={[
                    ['calendar', 'Calendar'],
                    ['custom', 'Custom date'],
                  ]}
                  value={block.align}
                  onChange={(align) => onPatch({ align })}
                />
                {block.align === 'custom' && (
                  <input
                    type="date"
                    className={`${styles.dateInput} focus-ring`}
                    aria-label="Start date"
                    // A date input reports a complete value on every keystroke of the
                    // year ("0002-…", "0020-…"), so the value saves on blur or Enter, and
                    // only when it is a date the block can run from.
                    value={startDraft ?? block.start}
                    onChange={(e) => setStartDraft(e.target.value)}
                    onBlur={commitStart}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                  />
                )}
              </div>
            </Field>
            <Field
              label="Selection"
              hint={`${SELECTION_HINTS[block.selection]} Can be changed per day on the workout.`}
              stack
            >
              <Seg
                label="Selection"
                options={FOCUS_SELECTIONS.map((selection) => [selection, SELECTION_LABELS[selection]] as const)}
                value={block.selection}
                onChange={(selection) => onPatch({ selection })}
              />
            </Field>
            <Field label={`When planned work trains ${areaWord}`} hint={overlapHint} stack>
              <Seg
                label={`When planned work trains ${areaWord}`}
                options={FOCUS_OVERLAPS.map((overlap) => [overlap, OVERLAP_LABELS[overlap]] as const)}
                value={block.overlap}
                onChange={(overlap) => onPatch({ overlap })}
              />
            </Field>
            <Field label="Progression" stack>
              <Seg
                label="Progression"
                options={FOCUS_PROGRESSIONS.map((progression) => [progression, PROGRESSION_LABELS[progression]] as const)}
                value={block.progression}
                onChange={(progression) => onPatch({ progression })}
              />
            </Field>

            <h3 className={styles.subTitle}>Lift pool</h3>
            <ul className={styles.poolList}>
              {block.pool.map((entry, index) => (
                <FocusPoolRow
                  key={entry.lift}
                  block={block}
                  entry={entry}
                  programLifts={programLifts}
                  unit={unit}
                  onChange={(next) => setPool(block.pool.map((other, i) => (i === index ? next : other)))}
                  onRemove={() =>
                    // A lift that swapped to the removed one keeps itself instead.
                    setPool(
                      block.pool
                        .filter((_, i) => i !== index)
                        .map((other) => (other.swapTo === entry.lift ? { ...other, swapTo: '' } : other)),
                    )
                  }
                />
              ))}
            </ul>
            {block.pool.length === 0 && <p className={styles.muted}>No lifts in the pool yet.</p>}
            {block.pool.length < MAX_POOL && (
              <div className={`${styles.row} ${styles.addRow}`}>
                <Select
                  label={`Add a lift to the ${area} pool`}
                  value=""
                  options={addLiftOptions(block)}
                  onChange={(lift) => {
                    if (lift) setPool([...block.pool, defaultPoolEntry(lift)]);
                  }}
                />
              </div>
            )}

            <h3 className={styles.subTitle}>Timer</h3>
            <div className={styles.timerGrid}>
              <div className={styles.mini}>
                <span aria-hidden="true">Setup</span>
                <Stepper
                  name="Setup time"
                  value={block.timer.prep}
                  step={5}
                  max={MAX_TIMER_SEC}
                  format={formatDuration}
                  onChange={(v) => setTimer('prep', v)}
                />
              </div>
              <div className={styles.mini}>
                <span aria-hidden="true">Set</span>
                <Stepper
                  name="Set time"
                  value={block.timer.set}
                  step={5}
                  max={MAX_TIMER_SEC}
                  format={formatDuration}
                  onChange={(v) => setTimer('set', v)}
                />
              </div>
              <div className={styles.mini}>
                <span aria-hidden="true">Rest</span>
                <Stepper
                  name="Rest time"
                  value={block.timer.rest}
                  step={15}
                  max={MAX_TIMER_SEC}
                  format={formatDuration}
                  onChange={(v) => setTimer('rest', v)}
                />
              </div>
            </div>

            <Field label="When it ends" hint="A summary of volume and PRs is shown either way.">
              <div className={styles.row}>
                <Seg
                  label="When it ends"
                  options={[
                    ['prompt', 'Prompt me'],
                    ['autoroll', 'Auto-roll'],
                  ]}
                  value={block.onEnd}
                  onChange={(onEnd) =>
                    onPatch(
                      onEnd === 'autoroll' ?
                        { onEnd, nextArea: block.nextArea ?? FOCUS_AREAS[0] }
                      : { onEnd, nextArea: null },
                    )
                  }
                />
                {block.onEnd === 'autoroll' && (
                  <Select<FocusArea>
                    label="Next area"
                    value={block.nextArea ?? FOCUS_AREAS[0]}
                    options={FOCUS_AREAS.map((next) => [next, `Next: ${next}`] as const)}
                    onChange={(nextArea) => onPatch({ nextArea })}
                  />
                )}
              </div>
            </Field>

            <button type="button" className={`${styles.linkBtn} ${styles.danger} focus-ring`} onClick={onRemove}>
              Remove this focus block
            </button>
          </>
        )}
      </div>
    </li>
  );
}
