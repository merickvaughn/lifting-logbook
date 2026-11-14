'use client';

import { useEffect, useState } from 'react';
import { MACROCYCLE_STATUSES } from '@lifting-logbook/types';
import type {
  AssignStartReason,
  AssignStatusReason,
  ImportAssignResponse,
  MacrocycleStatus,
} from '@lifting-logbook/types';
import { PROGRAMS } from '@/lib/programs';
import { STATUS_LABEL, STATUS_MARK } from '@/lib/macrocycleStatus';
import {
  canFile,
  canMoveStart,
  choicesFor,
  effectiveStretches,
  endOf,
  fileAllWithEarlier,
  fileSession,
  fmtDay,
  isSettled,
  joinWithPrevious,
  moveStart,
  openDecisions,
  overlaps,
  pendingSessions,
  previousStretchId,
  setProgram,
  setStatus,
  splitAtLargestGap,
  startOf,
  stretchName,
  type AssignDraft,
  type SessionChoice,
} from './assignDraft';
import styles from './AssignStep.module.css';

/** A program's display name: a custom program's own, or the built-in catalog's. */
function programNamer(res: ImportAssignResponse): (id: string) => string {
  const custom = new Map(res.programs.map((p) => [p.id, p.name]));
  return (id) => custom.get(id) ?? PROGRAMS.find((p) => p.id === id)?.name ?? id;
}

function startWhy(reason: AssignStartReason, name: (id: string) => string): string {
  switch (reason.kind) {
    case 'first-session':
      return 'The first workout in the file';
    case 'gap':
      return `New macrocycle: a ${reason.days}-day break`;
    case 'previous-run-finished':
      return 'New macrocycle: the run before it was finished';
    case 'program-column-changed':
      return `New macrocycle: the file’s Program column changes to ${name(reason.to)}`;
    case 'lift-outside-program':
      return `New macrocycle: ${reason.lifts.join(', ')} isn’t in the program before it`;
    case 'set-order-changed':
      return 'New macrocycle: the order of sets changes';
    case 'previous-fits-no-program':
      return 'New macrocycle: the workouts before it fit no program';
    case 'workout-number-fell-back':
      return `New macrocycle: the workout number drops from ${reason.from} to ${reason.to}`;
    case 'file-macrocycle':
      return `Your file’s macrocycle ${reason.macrocycleNum}`;
  }
}

function statusWhy(reason: AssignStatusReason): string {
  switch (reason.kind) {
    case 'all-workouts-done':
      return 'Every workout of the program was done.';
    case 'next-is-restart':
      return 'The program starts again after it.';
    case 'next-is-different-program':
      return 'A different program follows it.';
    case 'next-is-unmatched':
      return 'Workouts that fit no program follow it.';
    case 'last-session-stale':
      return `The last workout was ${reason.daysBeforeImport} days before this import.`;
    case 'past-expected-length':
      return `${reason.weeksSinceStart} weeks since it started, past the program’s length.`;
    case 'inside-expected-length':
      return `${reason.weeksSinceStart} weeks since it started, inside the program’s length.`;
    case 'open-ended':
      return 'A custom program has no set length, so choose a status.';
    case 'unmatched':
      return 'These workouts fit no program you have, so choose a status.';
  }
}

const statusClass = (status: MacrocycleStatus | null) => styles[`status-${status ?? 'unset'}`];
const statusText = (status: MacrocycleStatus | null) => (status ? STATUS_LABEL[status] : 'Status needed');

function Badge({ status }: { status: MacrocycleStatus | null }) {
  return (
    <span className={styles.badge}>
      <span className={styles.mark} aria-hidden="true">
        {STATUS_MARK[status ?? 'unset']}
      </span>
      {statusText(status)}
    </span>
  );
}

/** Each control's name holds its visible label, so a voice command naming the label finds it. */
const CHOICES: Record<SessionChoice, { label: string; name: (day: string) => string }> = {
  earlier: { label: 'With the earlier macrocycle', name: (d) => `File the ${d} workout with the earlier macrocycle` },
  later: { label: 'With the later macrocycle', name: (d) => `File the ${d} workout with the later macrocycle` },
  'non-cycle': { label: 'As a non-cycle workout', name: (d) => `Store the ${d} workout as a non-cycle workout` },
  exclude: { label: 'Leave out', name: (d) => `Leave out the ${d} workout` },
};

/** A stretch's card, which focus moves to after an edit removes the control that made it. */
const cardId = (id: string) => `assign-card-${id}`;
const DECISIONS_ID = 'assign-decisions';
const HEADING_ID = 'assign-heading';

/**
 * The Assign step (#1256): the rules' grouping of a lift-records file into macrocycles, for the
 * lifter to edit before the dry run. The wizard owns the draft; this renders it and reports edits.
 */
export default function AssignStep({
  res,
  draft,
  onChange,
  focusHeading = false,
}: {
  res: ImportAssignResponse;
  draft: AssignDraft;
  onChange: (next: AssignDraft) => void;
  /** Focus the heading when shown: the control the lifter last used is gone (#1256). */
  focusHeading?: boolean;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const name = programNamer(res);
  const stretches = effectiveStretches(draft, res);
  const pairs = overlaps(stretches);
  const overlapping = new Set(res.exported ? [] : pairs.flatMap(([a, b]) => [a.id, b.id]));
  const pending = pendingSessions(res);
  const left = openDecisions(draft, res);
  const lone = pending.filter((p) => !p.unnumbered && draft.filed[p.session.date] === undefined);
  const programIds = [...new Set([...res.programs.map((p) => p.id), ...stretches.map((s) => s.program)])];
  const toggle = (id: string, on: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // A stretch the lifter is editing stays open, so settling it doesn't collapse it under their focus.
  const editStretch = (id: string, next: AssignDraft) => {
    toggle(id, true);
    onChange(next);
  };
  // An edit that removes the control that made it (Join, Split, Keep every break) moves focus to
  // what it changed, rather than letting it fall to the page.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  useEffect(() => {
    if (focusTarget === null) return;
    document.getElementById(focusTarget)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);
  useEffect(() => {
    if (focusHeading) setFocusTarget(HEADING_ID);
  }, [focusHeading]);

  return (
    <div className={styles.step}>
      <h2 className={styles.heading} id={HEADING_ID} tabIndex={-1}>
        Assign your history to macrocycles
      </h2>
      <p className={styles.reason}>
        We grouped your workouts using their dates. These are suggestions: change anything before you
        continue. Macrocycles are numbered by date, so yours may be renumbered.
      </p>

      <p className={styles.summary} data-testid="assign-summary">
        {res.sessions} workout{res.sessions === 1 ? '' : 's'} in {stretches.length} macrocycle
        {stretches.length === 1 ? '' : 's'}.
      </p>
      {res.undatedRows > 0 && (
        <p className={styles.panel} data-testid="assign-undated">
          {res.undatedRows} row{res.undatedRows === 1 ? ' has' : 's have'} no date. They can’t be placed in a
          macrocycle, so they won’t be imported.
        </p>
      )}
      {res.nonCycle.length > 0 && (
        <p className={styles.panel}>
          {res.nonCycle.length} workout{res.nonCycle.length === 1 ? ' is' : 's are'} marked non-cycle in the file
          and will be stored outside any macrocycle.
        </p>
      )}
      {res.split && (
        <p className={styles.panel} data-testid="assign-split">
          {res.split.changes} one-rep-max row{res.split.changes === 1 ? '' : 's'} would change a training max.
          {res.split.olderThanCurrent > 0 &&
            ` ${res.split.olderThanCurrent} ${res.split.olderThanCurrent === 1 ? 'is' : 'are'} older than that program’s current max and won’t.`}
        </p>
      )}

      {res.conflicts.map((c) =>
        c.kind === 'gap-inside-number' ? (
          <p key={`gap-${c.stretch}`} className={styles.panel}>
            Your file numbers the workouts on both sides of a {c.days}-day break ({fmtDay(c.from)} to{' '}
            {fmtDay(c.to)}) as one macrocycle. We kept your numbering.
          </p>
        ) : null,
      )}

      {pairs.length > 0 &&
        (res.exported ? (
          <p className={styles.panel}>
            Some macrocycles in this export share dates. They’re kept as the export has them.
          </p>
        ) : (
          <section className={styles.decide} aria-labelledby="assign-overlaps">
            <p className={styles.eyebrow} id="assign-overlaps">
              MACROCYCLES SHARE DATES
            </p>
            <ul className={styles.list}>
              {pairs.map(([a, b]) => (
                <li key={`${a.id}-${b.id}`}>
                  {stretchName(a, name)} and {stretchName(b, name)} overlap. Join them, or move a boundary so
                  they don’t.
                </li>
              ))}
            </ul>
          </section>
        ))}

      {pending.length > 0 && (
        <section className={styles.decide} aria-labelledby="assign-pending">
          <p className={styles.eyebrow} id="assign-pending">
            YOUR CALL
          </p>
          {lone.length > 1 && (
            <div className={styles.options}>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  onChange(fileAllWithEarlier(draft, res));
                  setFocusTarget(DECISIONS_ID);
                }}
              >
                Keep every break: file the {lone.length} one-lift workouts with the macrocycle before each
              </button>
            </div>
          )}
          <ul className={styles.list}>
            {pending.map((p) => {
              const day = fmtDay(p.session.date);
              const chosen = draft.filed[p.session.date];
              const headingId = `assign-pending-${p.session.date}`;
              return (
                <li key={p.session.date} className={styles.panel}>
                  <p className={styles.heading} id={headingId}>
                    {p.unnumbered
                      ? `Workout on ${day} has no macrocycle number`
                      : `One-lift workout on ${day}, in a break`}
                  </p>
                  <p className={styles.reason}>
                    {p.session.lifts.join(', ')}
                    {p.daysAfterPrevious !== null && `, ${p.daysAfterPrevious} days after the workout before it`}
                    {p.daysBeforeNext !== null && `, ${p.daysBeforeNext} days before the next`}.
                  </p>
                  {/* One choice per session: the group says which session its buttons file. */}
                  <div className={styles.options} role="group" aria-labelledby={headingId}>
                    {choicesFor(p, res).map((choice) => {
                      const { label, name: controlName } = CHOICES[choice];
                      const unavailable =
                        (choice === 'earlier' || choice === 'later') && !canFile(draft, p.session.date, choice);
                      return (
                        <button
                          key={choice}
                          type="button"
                          className={styles.btn}
                          aria-pressed={chosen === choice}
                          aria-disabled={unavailable || undefined}
                          aria-label={controlName(day)}
                          onClick={() => {
                            if (!unavailable) onChange(fileSession(draft, p.session.date, choice));
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <ol className={styles.list} aria-label="Macrocycles">
        {stretches.map((s, i) => {
          const label = stretchName(s, name);
          const settled = isSettled(s, overlapping);
          const expanded = !settled || open.has(s.id);
          const span = `${fmtDay(startOf(s))} to ${fmtDay(endOf(s))}`;
          const workouts = `${s.sessions.length}${s.source?.expectedWorkouts ? ` of ${s.source.expectedWorkouts}` : ''} workouts`;
          const placed = s.source === null || startOf(s) !== s.source.startDate;
          return (
            <li key={s.id} className={styles.step}>
              {i > 0 && !res.exported && (
                <div className={styles.boundary}>
                  <span className={styles.why}>
                    {placed || !s.source ? 'New macrocycle: you placed this boundary' : startWhy(s.source.reasons.start, name)}
                  </span>
                  {(['earlier', 'later'] as const).map((direction) => {
                    const able = canMoveStart(draft, s.id, direction);
                    return (
                      <button
                        key={direction}
                        type="button"
                        className={styles.btn}
                        aria-disabled={!able || undefined}
                        aria-label={`Start ${label} one workout ${direction}`}
                        onClick={() => {
                          if (able) onChange(moveStart(draft, s.id, direction));
                        }}
                      >
                        {direction === 'earlier' ? '← Earlier' : 'Later →'}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={styles.btn}
                    aria-label={`Join ${label} with the macrocycle before it`}
                    onClick={() => {
                      const kept = previousStretchId(draft, s.id);
                      if (kept === null) return;
                      editStretch(kept, joinWithPrevious(draft, s.id));
                      setFocusTarget(cardId(kept));
                    }}
                  >
                    Join
                  </button>
                </div>
              )}
              {/* A settled stretch's row opens and closes it, and stays where it is either way. */}
              {settled && (
                <button
                  type="button"
                  className={`${styles.row} ${statusClass(s.status)}`}
                  aria-expanded={expanded}
                  aria-controls={expanded ? cardId(s.id) : undefined}
                  data-testid="assign-settled"
                  onClick={() => toggle(s.id, !expanded)}
                >
                  <span className={styles.rowText}>
                    {name(s.program)} · {span} · {s.sessions.length} workouts
                  </span>
                  <Badge status={s.status} />
                </button>
              )}
              {expanded && (
                <section
                  id={cardId(s.id)}
                  tabIndex={-1}
                  className={`${styles.card} ${statusClass(s.status)}`}
                  aria-label={label}
                >
                  <p className={styles.heading}>
                    {name(s.program)} · {span}
                  </p>
                  <Badge status={s.status} />
                  <p className={styles.reason}>
                    {workouts}.
                    {s.source && !s.statusChosen && s.status === s.source.status && ` ${statusWhy(s.source.reasons.status)}`}
                  </p>
                  {s.source && s.source.liftsOutsideProgram.length > 0 && (
                    <p className={styles.reason}>
                      {s.source.liftsOutsideProgram.join(', ')} {s.source.liftsOutsideProgram.length === 1 ? 'isn’t' : 'aren’t'} in{' '}
                      {name(s.program)}.
                    </p>
                  )}
                  {s.source && !s.source.matched && s.program === s.source.program && (
                    <p className={styles.reason}>
                      These workouts fit no program you have. They’ll be stored under {name(s.program)} and flagged as
                      unmatched.
                    </p>
                  )}
                  <div className={styles.fields}>
                    <label>
                      Program
                      <select
                        aria-label={`Program for ${label}`}
                        value={s.program}
                        onChange={(e) => editStretch(s.id, setProgram(draft, s.id, e.target.value))}
                      >
                        {programIds.map((id) => (
                          <option key={id} value={id}>
                            {name(id)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Status
                      <select
                        aria-label={`Status for ${label}`}
                        value={s.status ?? ''}
                        onChange={(e) => {
                          const value = MACROCYCLE_STATUSES.find((status) => status === e.target.value);
                          if (value) editStretch(s.id, setStatus(draft, s.id, value));
                        }}
                      >
                        {s.status === null && <option value="">Choose a status</option>}
                        {MACROCYCLE_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABEL[status]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {/* Filed lone sessions stay where they were filed, so only the stretch's own sessions split. */}
                    {!res.exported && (draft.stretches.find((x) => x.id === s.id)?.sessions.length ?? 0) > 1 && (
                      <button
                        type="button"
                        className={styles.btn}
                        aria-label={`Split at largest gap: ${label}`}
                        onClick={() => {
                          editStretch(s.id, splitAtLargestGap(draft, s.id));
                          setFocusTarget(cardId(s.id));
                        }}
                      >
                        Split at largest gap
                      </button>
                    )}
                  </div>
                </section>
              )}
            </li>
          );
        })}
      </ol>

      <p className={styles.summary} role="status" id={DECISIONS_ID} tabIndex={-1} data-testid="assign-decisions">
        {left === 0
          ? 'Nothing left to decide. Continue to Preview.'
          : `${left} decision${left === 1 ? '' : 's'} left before Preview.`}
      </p>
    </div>
  );
}
