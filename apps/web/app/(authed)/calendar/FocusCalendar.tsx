'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { daysLeft, defaultFocusPool, nextStart, parseIsoDate, rangeLabel } from '@lifting-logbook/core';
import {
  FOCUS_AREAS,
  type FocusArea,
  type FocusBlockResponse,
  type FocusBlockStatus,
  type FocusBlockSummaryResponse,
  type WeightUnit,
} from '@lifting-logbook/types';
import { createFocusBlock, deleteFocusBlock, fetchFocusBlocks, fetchFocusBlockSummary } from '@/lib/client-api';
import {
  autoRollSource,
  barPlacement,
  blockWeek,
  calendarWindow,
  dateSpanLabel,
  focusLanes,
  monthTicks,
  shortDate,
  todayOffset,
  type CalendarWindow,
  type DatedPhase,
} from '@/lib/focusCalendar';
import {
  FOCUS_OVERLAP_LABELS,
  FOCUS_PROGRESSION_LABELS,
  FOCUS_SELECTION_LABELS,
  focusAreaColor,
} from '@/lib/focusDisplay';
import { localIsoDate } from '@/lib/localDate';
import { logClientError } from '@/lib/log-client-error';
import styles from './FocusCalendar.module.css';

/** The renew prompt shows from this many days before a focus block's last day. */
const RENEW_PROMPT_DAYS = 10;

const STATUS_LABELS: Record<FocusBlockStatus, string> = {
  active: 'Active',
  ended: 'Ended',
  queued: 'Queued',
};

const MONTH_LONG = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });

type Selection = { kind: 'phase'; index: number } | { kind: 'block'; id: string };

interface Props {
  phases: DatedPhase[];
  unit: WeightUnit;
}

function placementStyle(start: string, end: string, view: CalendarWindow): CSSProperties | null {
  const placement = barPlacement(start, end, view);
  return placement && { left: `${placement.left}%`, width: `${placement.width}%` };
}

function Dot({ area }: { area: FocusArea }) {
  return <span className={styles.dot} style={{ background: focusAreaColor(area) }} aria-hidden="true" />;
}

export default function FocusCalendar({ phases, unit }: Props) {
  // Set after mount: the server doesn't know the user's calendar day (ADR-039 §5), and
  // rendering it on the server would mismatch on hydration.
  const [today, setToday] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<FocusBlockResponse[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);

  // Only the latest fetch may land, so a slow earlier one can't bring back a cancelled block.
  const latestLoad = useRef(0);
  const shownDay = useRef<string | null>(null);

  const load = useCallback(async (day: string) => {
    const request = ++latestLoad.current;
    try {
      const fresh = await fetchFocusBlocks(day);
      if (request !== latestLoad.current) return;
      setBlocks(fresh);
      setLoadError(false);
    } catch (err) {
      logClientError('fetchFocusBlocks', err, { today: day });
      if (request === latestLoad.current) setLoadError(true);
    }
  }, []);

  // Reads the day again when the tab comes back, so a page left open past midnight moves on.
  useEffect(() => {
    const sync = () => {
      const day = localIsoDate();
      if (day === shownDay.current) return;
      shownDay.current = day;
      setToday(day);
      void load(day);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    sync();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  if (!today) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Calendar</h1>
        <p className={styles.sub}>Loading…</p>
      </main>
    );
  }

  const view = calendarWindow(today);
  const lanes = blocks ? focusLanes(blocks, view) : [];
  const todayLeft = `${todayOffset(today, view)}%`;
  const ticks = monthTicks(view);
  const grid = (
    <>
      {ticks.map((tick) => (
        <span key={tick.start} className={styles.gridLine} style={{ left: `${tick.left}%` }} aria-hidden="true" />
      ))}
      <span className={styles.todayLine} style={{ left: todayLeft }} aria-hidden="true" />
    </>
  );

  const selectedPhase = selection?.kind === 'phase' ? phases[selection.index] : undefined;
  const selectedBlock =
    selection?.kind === 'block' ? blocks?.find((b) => b.id === selection.id) : undefined;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Calendar</h1>
      <p className={styles.sub}>
        The program and focus blocks run on separate timelines. Tap a bar for details.
      </p>

      <div className={styles.gantt}>
        <div className={`${styles.row} ${styles.headRow}`}>
          <span className={styles.label} />
          <div className={styles.track}>
            {ticks.map((tick) => (
              <span key={tick.start} className={styles.month} style={{ left: `${tick.left}%` }}>
                {tick.label}
              </span>
            ))}
            <span className={styles.todayLabel} style={{ left: todayLeft }}>
              Today
            </span>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.label}>
            <b>Program</b>
          </span>
          <div className={styles.track}>
            {grid}
            {!phases.some((p) => barPlacement(p.start, p.end, view)) && (
              <span className={styles.trackNote}>
                {phases.length === 0 ? (
                  <>
                    No current macrocycle. <Link href="/programs">Choose a program</Link>
                  </>
                ) : (
                  'No program phases in this window.'
                )}
              </span>
            )}
            {phases.map((phase, index) => {
              const style = placementStyle(phase.start, phase.end, view);
              if (!style) return null;
              const selected = selectedPhase === phase;
              const deload = phase.type === 'deload';
              return (
                <button
                  key={`${phase.name}-${phase.start}`}
                  type="button"
                  className={[styles.bar, styles.program, deload && styles.deload, selected && styles.selected]
                    .filter(Boolean)
                    .join(' ')}
                  style={style}
                  aria-label={`${phase.name}, ${dateSpanLabel(phase.start, phase.end)}`}
                  aria-pressed={selected}
                  title={phase.name}
                  onClick={() => setSelection({ kind: 'phase', index })}
                >
                  {deload ? '' : phase.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.divider}>Focus</div>
        {lanes.map((lane) => (
          <div className={styles.row} key={lane.series}>
            <span className={styles.label}>{lane.label}</span>
            <div className={styles.track}>
              {grid}
              {lane.blocks.map((block) => {
                const placed = placementStyle(block.rangeStart, block.rangeEnd, view);
                if (!placed) return null;
                const selected = selectedBlock?.id === block.id;
                const color = focusAreaColor(block.area);
                const style: CSSProperties =
                  block.status === 'queued'
                    ? { ...placed, borderColor: color, color: focusAreaColor(block.area, 0.42) }
                    : { ...placed, background: color };
                return (
                  <button
                    key={block.id}
                    type="button"
                    className={[styles.bar, styles[block.status], selected && styles.selected]
                      .filter(Boolean)
                      .join(' ')}
                    style={style}
                    aria-label={`${block.area} focus block, ${rangeLabel(block)}, ${block.status}`}
                    aria-pressed={selected}
                    title={`${block.area} · ${rangeLabel(block)}`}
                    onClick={() => setSelection({ kind: 'block', id: block.id })}
                  >
                    {block.area}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {blocks && lanes.length === 0 && (
          <p className={styles.empty}>
            No focus blocks yet. <Link href="/programs/focus">Add one in Programs</Link>.
          </p>
        )}
        {!blocks && !loadError && <p className={styles.empty}>Loading focus blocks…</p>}
        {loadError && (
          <p className={styles.error} role="alert">
            Couldn’t load your focus blocks. Reload the page to try again.
          </p>
        )}
      </div>

      <div className={styles.legend} aria-hidden="true">
        <span>
          <i className={`${styles.swatch} ${styles.swatchActive}`} />
          Active
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchEnded}`} />
          Ended
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchQueued}`} />
          Queued
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchToday}`} />
          Today
        </span>
      </div>

      {selectedPhase && <PhaseDetail phase={selectedPhase} />}
      {selectedBlock && blocks && (
        <BlockDetail
          key={selectedBlock.id}
          block={selectedBlock}
          blocks={blocks}
          today={today}
          unit={unit}
          onChanged={async (apply, cleared) => {
            // Shown at once, so the result doesn't depend on the refetch succeeding.
            setBlocks((current) => current && apply(current));
            if (cleared) setSelection(null);
            await load(today);
          }}
        />
      )}
    </main>
  );
}

function PhaseDetail({ phase }: { phase: DatedPhase }) {
  return (
    <section className={styles.card} aria-label="Selected program phase">
      <h2 className={styles.detailTitle}>{phase.name}</h2>
      <p className={styles.hint}>
        {dateSpanLabel(phase.start, phase.end)} · {phase.weeks} {phase.weeks === 1 ? 'week' : 'weeks'}
      </p>
    </section>
  );
}

interface BlockDetailProps {
  block: FocusBlockResponse;
  blocks: FocusBlockResponse[];
  today: string;
  unit: WeightUnit;
  /**
   * Called after a change is saved with how it changes the list, which is applied before the
   * refetch; `cleared` when the selected focus block is gone.
   */
  onChanged: (apply: (blocks: FocusBlockResponse[]) => FocusBlockResponse[], cleared: boolean) => Promise<void>;
}

function BlockDetail({ block, blocks, today, unit, onChanged }: BlockDetailProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      // Deleting a queued focus block also stops the one it rolls from creating it again.
      await deleteFocusBlock(block.id);
      await onChanged((current) => current.filter((b) => b.id !== block.id), true);
    } catch (err) {
      logClientError('deleteFocusBlock', err, { blockId: block.id });
      setError('Couldn’t cancel this focus block. Please try again.');
      setBusy(false);
    }
  }

  const source = block.status === 'queued' ? autoRollSource(block, blocks) : undefined;

  return (
    <section className={styles.card} aria-label="Selected focus block">
      <h2 className={styles.detailTitle}>
        <Dot area={block.area} />
        {block.area} · {rangeLabel(block)}
        <span className={`${styles.statusPill} ${block.status === 'active' ? styles.statusActive : ''}`}>
          {STATUS_LABELS[block.status]}
        </span>
      </h2>
      <p className={styles.hint}>
        {dateSpanLabel(block.rangeStart, block.rangeEnd)} · {block.period},{' '}
        {block.align === 'calendar' ? 'calendar-aligned' : 'custom start'}
      </p>

      {block.status === 'ended' && <BlockSummary blockId={block.id} unit={unit} />}

      {block.status === 'active' && (
        <ActiveDetail block={block} blocks={blocks} today={today} onChanged={onChanged} />
      )}

      {block.status === 'queued' && (
        <>
          <p className={styles.hint}>
            {source
              ? `Auto-rolls from ${source.area} when it ends.`
              : `Queued. Starts ${shortDate(block.rangeStart)}.`}
          </p>
          <button type="button" className={styles.button} onClick={cancel} disabled={busy}>
            {busy ? 'Cancelling…' : 'Cancel'}
          </button>
        </>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ActiveDetail({
  block,
  blocks,
  today,
  onChanged,
}: Pick<BlockDetailProps, 'block' | 'blocks' | 'today' | 'onChanged'>) {
  const { week, weeks } = blockWeek(block, today);
  // Core's expandRollovers skips an auto-roll with no next area, so that one prompts too.
  const rolls = block.onEnd === 'autoroll' && block.nextArea !== null;
  const showRenew =
    !rolls &&
    daysLeft(block, today) <= RENEW_PROMPT_DAYS &&
    !blocks.some((b) => b.series === block.series && b.status === 'queued');

  return (
    <>
      <div className={styles.progressRow}>
        <div className={styles.progressTrack}>
          <div
            className={styles.progressFill}
            style={{ width: `${(week / weeks) * 100}%`, background: focusAreaColor(block.area) }}
          />
        </div>
        <span className={styles.hint}>
          Week {week} of {weeks}
        </span>
      </div>
      <dl className={styles.kv}>
        <dt>Selection</dt>
        <dd>{FOCUS_SELECTION_LABELS[block.selection]}</dd>
        <dt>On overlap</dt>
        <dd>{FOCUS_OVERLAP_LABELS[block.overlap]}</dd>
        <dt>Progression</dt>
        <dd>{FOCUS_PROGRESSION_LABELS[block.progression]}</dd>
        <dt>Pool</dt>
        <dd>{block.pool.length > 0 ? block.pool.map((p) => p.lift).join(', ') : 'Empty'}</dd>
        <dt>When it ends</dt>
        <dd>
          {rolls ? `Auto-roll to ${block.nextArea}` : 'Prompt me'}
        </dd>
      </dl>
      {showRenew && <RenewPrompt block={block} today={today} onChanged={onChanged} />}
      <Link className={styles.button} href={`/programs/focus?block=${encodeURIComponent(block.id)}`}>
        Edit in Programs
      </Link>
    </>
  );
}

function RenewPrompt({ block, today, onChanged }: Pick<BlockDetailProps, 'block' | 'today' | 'onChanged'>) {
  const others = FOCUS_AREAS.filter((a) => a !== block.area);
  const [pick, setPick] = useState<FocusArea>(
    block.nextArea && block.nextArea !== block.area ? block.nextArea : (others[0] ?? block.area),
  );
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dismissed) return null;

  const start = nextStart(block);
  const left = daysLeft(block, today);

  async function queue(area: FocusArea) {
    setBusy(true);
    setError(null);
    try {
      // The successor joins this series and keeps its priority, as an auto-roll successor
      // does, so it takes over this lane when this one ends.
      const created = await createFocusBlock(
        {
          series: block.series,
          priority: block.priority,
          area,
          period: block.period,
          align: block.align,
          start,
          selection: block.selection,
          overlap: block.overlap,
          progression: block.progression,
          timer: block.timer,
          onEnd: block.onEnd,
          nextArea: block.nextArea,
          pool: area === block.area ? block.pool : defaultFocusPool(area),
        },
        today,
      );
      await onChanged((current) => [...current, created], false);
    } catch (err) {
      logClientError('createFocusBlock', err, { series: block.series, area });
      setError('Couldn’t queue the next focus block. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className={styles.prompt}>
      <p className={styles.promptTitle}>
        <Dot area={block.area} />
        {block.area} ({rangeLabel(block)}) {left === 0 ? 'ends today' : `ends in ${left} ${left === 1 ? 'day' : 'days'}`}
      </p>
      <p className={styles.hint}>Choose what follows. A summary of volume and PRs appears when it ends.</p>
      <div className={styles.promptButtons}>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => queue(block.area)} disabled={busy}>
          Renew for {block.period === 'quarterly' ? 'next quarter' : MONTH_LONG.format(parseIsoDate(start))}
        </button>
        <span className={styles.pickNext}>
          <select
            className={styles.select}
            aria-label="Next focus area"
            value={pick}
            onChange={(e) => setPick(others.find((a) => a === e.target.value) ?? pick)}
            disabled={busy}
          >
            {others.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
          <button type="button" className={styles.button} onClick={() => queue(pick)} disabled={busy}>
            Queue
          </button>
        </span>
        <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setDismissed(true)} disabled={busy}>
          Let it end
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Two decimals at most, so a difference of decimal weights shows no float noise. */
const WEIGHT_DELTA = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function prDelta(pr: FocusBlockSummaryResponse['prs'][number], unit: WeightUnit): string {
  return pr.weight > pr.previousWeight
    ? `+${WEIGHT_DELTA.format(pr.weight - pr.previousWeight)} ${unit}`
    : `+${pr.reps - pr.previousReps} ${pr.reps - pr.previousReps === 1 ? 'rep' : 'reps'}`;
}

function BlockSummary({ blockId, unit }: { blockId: string; unit: WeightUnit }) {
  const [summary, setSummary] = useState<FocusBlockSummaryResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    fetchFocusBlockSummary(blockId).then(
      (result) => {
        if (current) setSummary(result);
      },
      (err: unknown) => {
        logClientError('fetchFocusBlockSummary', err, { blockId });
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [blockId]);

  if (failed) {
    return (
      <p className={styles.error} role="alert">
        Couldn’t load this focus block’s summary.
      </p>
    );
  }
  if (!summary) return <p className={styles.hint}>Loading summary…</p>;

  return (
    <div className={styles.summary}>
      <dl className={styles.summaryGrid}>
        <div>
          <dt>Sessions</dt>
          <dd>{summary.sessions}</dd>
        </div>
        <div>
          <dt>Sets</dt>
          <dd>{summary.sets}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>
            {summary.volume.toLocaleString('en-US')} {unit}
          </dd>
        </div>
      </dl>
      <h3 className={styles.summaryLabel}>PRs</h3>
      {summary.prs.length > 0 ? (
        <ul className={styles.prList}>
          {summary.prs.map((pr) => (
            <li key={pr.lift}>
              {pr.lift}: {pr.weight} {unit} × {pr.reps} ({prDelta(pr, unit)})
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.hint}>No PRs in this focus block.</p>
      )}
    </div>
  );
}
