'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiClientError } from '@lifting-logbook/api-client';
import type { LiftModificationResponse, WeightUnit } from '@lifting-logbook/types';
import { convertWeight, formatWeight, liftOccurrenceKey, roundToDisplay, withOccurrence } from '@lifting-logbook/core';
import {
  createLiftModification,
  createLiftRecord,
  fetchLiftModifications,
  recordBodyWeight,
  rescheduleWorkout,
  updateLiftRecord,
} from '@/lib/client-api';
import { modificationSuffix } from '@/lib/liftModifications';
import { logClientError } from '@/lib/log-client-error';
import { followMovedMacrocycle, writeFailureMessage } from '@/lib/macrocycleUrl';
import styles from './WorkoutLogger.module.css';
import type { LiftData, LoggedSet, WorkingSetData, WorkoutLoggerProps } from './types';
import {
  buildDraftKey,
  buildModificationsDraftKey,
  clearDraft,
  readDraft,
  readModificationsDraft,
  writeDraft,
  writeModificationsDraft,
} from './workoutDraftStorage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A lift occurrence's identity in this workout. A program can plan one lift twice in
// a day, so the lift's name alone would give both occurrences one key, and logging a
// set on one would mark the other's logged too (#1027).
function liftKey(lift: Pick<LiftData, 'lift' | 'occurrence'>): string {
  return liftOccurrenceKey(lift.lift, lift.occurrence);
}

function setKey(lift: Pick<LiftData, 'lift' | 'occurrence'>, setNum: number): string {
  return `${liftKey(lift)}-${setNum}`;
}

// Plan loads and logged lift records are always stored in lbs; `unit` is the
// user's display preference. These format helpers convert for display only — the
// numeric value logged to the API is never converted (see
// docs/standards/training-max-precision.md).

function formatWarmUpWeight(
  totalLoad: number,
  bodyWeight: number | null,
  isBodyweightComponent: boolean,
  unit: WeightUnit,
): string {
  if (!isBodyweightComponent || bodyWeight === null) {
    return formatWeight(totalLoad, 'lbs', unit);
  }
  if (totalLoad <= bodyWeight) {
    return 'BW';
  }
  return `+${formatWeight(totalLoad - bodyWeight, 'lbs', unit)}`;
}

function formatWorkingWeight(
  totalLoad: number,
  bodyWeight: number | null,
  isBodyweightComponent: boolean,
  unit: WeightUnit,
): { display: string; value: number } {
  if (!isBodyweightComponent || bodyWeight === null) {
    return { display: formatWeight(totalLoad, 'lbs', unit), value: totalLoad };
  }
  // Round the added lbs load: a kg-entered body weight is a full-precision
  // conversion, so `totalLoad - bodyWeight` carries float noise that would
  // otherwise surface raw in the pre-filled (lbs) weight input. `value` stays in
  // lbs — never the converted display number, or logging would corrupt the stored
  // weight.
  const added = roundToDisplay(Math.max(0, totalLoad - bodyWeight));
  return { display: `+${formatWeight(added, 'lbs', unit)}`, value: added };
}

function modificationIds(record: LoggedSet | undefined): string[] {
  return (record?.modifications ?? []).map((m) => m.id);
}

/** `ids` with `id` toggled. Turning on one with its own max turns off any other: a set can have one. */
function toggleModification(
  ids: readonly string[],
  id: string,
  modifications: readonly Pick<LiftModificationResponse, 'id' | 'maxMode'>[],
): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  const ownMax = (x: string) => modifications.find((m) => m.id === x)?.maxMode === 'own';
  return [...ids.filter((x) => !(ownMax(id) && ownMax(x))), id];
}

/**
 * The message for a write that sent modifications and got a 400, when the refreshed list shows one
 * of them was removed elsewhere (#1152); `null` for any other failure.
 */
async function staleModificationMessage(
  err: unknown,
  sent: readonly string[],
  refresh: () => Promise<LiftModificationResponse[] | null>,
): Promise<string | null> {
  if (sent.length === 0 || !(err instanceof ApiClientError) || err.status !== 400) return null;
  const live = await refresh();
  if (!live || sent.every((id) => live.some((m) => m.id === id))) return null;
  return 'A modification on this set was removed. Check the toggles and log again.';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function BodyWeightGate({
  onSubmit,
  unit,
}: {
  onSubmit: (weight: number) => Promise<void>;
  unit: WeightUnit;
}) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Realistic body-weight bounds are defined in lbs; convert them so the input's
  // min/max stay sensible when the preferred unit is kg.
  const minWeight = Math.round(convertWeight(50, 'lbs', unit));
  const maxWeight = Math.round(convertWeight(500, 'lbs', unit));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const weight = Number(input);
    if (!weight || weight <= 0) {
      setError('Enter a valid body weight.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(weight);
    } catch (err) {
      logClientError('recordBodyWeight', err);
      setError('Failed to save body weight. Try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.gate}>
      <h2 className={styles.gateHeading}>Body Weight</h2>
      <p className={styles.gateHint}>
        This workout includes bodyweight lifts. Enter your weight to
        calculate added load.
      </p>
      <form className={styles.gateForm} onSubmit={handleSubmit}>
        <label className={styles.gateLabel} htmlFor="bw-input">
          Body weight ({unit})
        </label>
        <input
          id="bw-input"
          className={styles.gateInput}
          type="number"
          min={minWeight}
          max={maxWeight}
          step="0.5"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
        {error && <p className={styles.gateError}>{error}</p>}
        <button
          className={styles.gateSubmit}
          type="submit"
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}

/**
 * A row of toggle buttons, one per modification, each `aria-pressed`. The description of each one
 * that is on shows under the row (#1152).
 */
function ModificationToggles({
  label,
  modifications,
  active,
  disabled,
  onToggle,
  children,
}: {
  label: string;
  modifications: readonly Pick<LiftModificationResponse, 'id' | 'name' | 'description'>[];
  active: readonly string[];
  disabled?: boolean;
  onToggle: (id: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.modRow} role="group" aria-label={label}>
      {modifications.map((m) => (
        <button
          key={m.id}
          className={styles.modToggle}
          type="button"
          aria-pressed={active.includes(m.id)}
          disabled={disabled}
          onClick={() => onToggle(m.id)}
        >
          {m.name}
        </button>
      ))}
      {children}
      {modifications
        .filter((m) => m.description && active.includes(m.id))
        .map((m) => (
          <p key={m.id} className={styles.modDescription}>
            {m.description}
          </p>
        ))}
    </div>
  );
}

/** The inline **Add**: a name, created as a modification of `lift` that moves no max (#1152). */
function AddModification({
  program,
  lift,
  onAdded,
}: {
  program: string;
  lift: string;
  onAdded: (modification: LiftModificationResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button className={styles.modAdd} type="button" aria-label="Add modification" onClick={() => setOpen(true)}>
        + Add
      </button>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await createLiftModification({ lift, name: trimmed });
      setSubmitting(false);
      if (!result.ok) {
        setError(result.conflictMessage);
        return;
      }
      setName('');
      setOpen(false);
      onAdded(result.data);
    } catch (err) {
      logClientError('createLiftModification', err, { program, lift });
      setError(writeFailureMessage(err, 'Failed to add the modification. Try again.'));
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.modForm} onSubmit={handleSubmit}>
      <input
        className={styles.modInput}
        type="text"
        aria-label="Modification name"
        placeholder="e.g. Paused"
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={submitting}
        autoFocus
      />
      <button className={styles.modAdd} type="submit" aria-label="Save modification" disabled={submitting}>
        {submitting ? '…' : 'Save'}
      </button>
      <button className={styles.modAdd} type="button" onClick={() => setOpen(false)} disabled={submitting}>
        Cancel
      </button>
      {error && <p className={styles.setError}>{error}</p>}
    </form>
  );
}

function WarmUpRow({
  label,
  totalLoad,
  reps,
  bodyWeight,
  isBodyweightComponent,
  unit,
}: {
  label: string;
  totalLoad: number;
  reps: number;
  bodyWeight: number | null;
  isBodyweightComponent: boolean;
  unit: WeightUnit;
}) {
  const weightStr = formatWarmUpWeight(totalLoad, bodyWeight, isBodyweightComponent, unit);
  return (
    <li className={styles.warmUpRow}>
      <span className={styles.warmUpLabel}>{label}</span>
      <span className={styles.warmUpWeight}>
        {weightStr} × {reps}
      </span>
    </li>
  );
}

function WorkingSetRow({
  lift,
  occurrence,
  set,
  bodyWeight,
  isBodyweightComponent,
  isReadOnly,
  loggedRecord,
  isEditing,
  program,
  macrocycleNum,
  macrocycleId,
  workoutNum,
  date,
  unit,
  modifications,
  activeModifications,
  onRefreshModifications,
  onLogged,
  onEditStart,
  onEditSave,
}: {
  lift: string;
  /** Which occurrence of `lift` in the workout (`LiftData.occurrence`); absent means 0. */
  occurrence: number | undefined;
  set: WorkingSetData;
  /** The lift's modifications, or `null`/absent when the fetch failed or hasn't returned (#1152). */
  modifications: readonly LiftModificationResponse[] | null | undefined;
  /** The ids toggled on, sent with a new set. */
  activeModifications: readonly string[];
  /** Fetches the lift's modifications again; `null` if that fails. */
  onRefreshModifications: () => Promise<LiftModificationResponse[] | null>;
  bodyWeight: number | null;
  isBodyweightComponent: boolean;
  isReadOnly: boolean;
  loggedRecord?: LoggedSet;
  isEditing: boolean;
  program: string;
  macrocycleNum: number;
  /** The macrocycle's stable id, sent with each write (#1198). */
  macrocycleId: string | undefined;
  workoutNum: number;
  date: string;
  unit: WeightUnit;
  onLogged: (record: LoggedSet) => void;
  onEditStart: () => void;
  onEditSave: (record: LoggedSet) => void;
}) {
  const { value: defaultWeight } = formatWorkingWeight(
    set.totalLoad,
    bodyWeight,
    isBodyweightComponent,
    unit,
  );
  // Pre-fill from the logged record when entering edit mode; fall back to plan defaults for new logs.
  // The pre-filled value is always the native lbs number — the input and everything submitted stay
  // in lbs (lift records have no per-record unit); `unit` only drives the read-only ≈ hint below.
  //
  // Drafts only ever apply to the fresh "Log" form — never a read-only workout, and never an
  // edit-in-progress (editingSet resets to null on reload, so a drafted edit has no restoration
  // path). Gating on isReadOnly matters even though isReadOnly implies loggedRecord in practice
  // (page.tsx only sets it once every set is logged): WorkingSetRow doesn't itself enforce that
  // invariant, and hooks run unconditionally before the isReadOnly early-return below, so without
  // this guard an isReadOnly + unlogged row (exercised directly by the isReadOnly test in
  // WorkoutLogger.test.tsx) would still read a stray draft into unused state.
  const shouldDraft = !loggedRecord && !isReadOnly;
  const draftStorageKey = buildDraftKey(program, macrocycleNum, workoutNum, lift, set.setNum, occurrence, macrocycleId);
  // The number-keyed draft from before the page had an id, moved on first read (#1198).
  const legacyDraftKey = macrocycleId
    ? buildDraftKey(program, macrocycleNum, workoutNum, lift, set.setNum, occurrence)
    : undefined;

  const [weightInput, setWeightInput] = useState(() => {
    if (shouldDraft) {
      const draft = readDraft(draftStorageKey, legacyDraftKey);
      if (draft) return draft.weight;
    }
    return loggedRecord
      ? String(formatWorkingWeight(loggedRecord.weight, null, false, unit).value)
      : String(defaultWeight);
  });
  const [repsInput, setRepsInput] = useState(() => {
    if (shouldDraft) {
      const draft = readDraft(draftStorageKey);
      if (draft) return draft.reps;
    }
    return String(loggedRecord?.reps ?? set.reps);
  });
  const [notesInput, setNotesInput] = useState(() => {
    if (shouldDraft) {
      const draft = readDraft(draftStorageKey);
      if (draft) return draft.notes;
    }
    return loggedRecord?.notes ?? '';
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The modifications chosen while editing a logged set, reset from the set on each Edit.
  const [editModifications, setEditModifications] = useState<string[]>(() => modificationIds(loggedRecord));

  const isLogged = !!loggedRecord && !isEditing;

  function handleEditStart() {
    setEditModifications(modificationIds(loggedRecord));
    onEditStart();
  }

  function handleWeightInputChange(value: string) {
    setWeightInput(value);
    if (shouldDraft) writeDraft(draftStorageKey, { weight: value, reps: repsInput, notes: notesInput });
  }
  function handleRepsInputChange(value: string) {
    setRepsInput(value);
    if (shouldDraft) writeDraft(draftStorageKey, { weight: weightInput, reps: value, notes: notesInput });
  }
  function handleNotesInputChange(value: string) {
    setNotesInput(value);
    if (shouldDraft) writeDraft(draftStorageKey, { weight: weightInput, reps: repsInput, notes: value });
  }

  async function handleLog(e: React.FormEvent) {
    e.preventDefault();
    const weight = Number(weightInput);
    const reps = Number(repsInput);
    if (isNaN(weight) || weight < 0 || isNaN(reps) || reps <= 0) {
      setError('Enter valid weight and reps.');
      return;
    }
    setError(null);
    setSubmitting(true);
    // Left out when empty, so a set with no modifications sends what it always did.
    const sent = [...activeModifications];
    try {
      const record = await createLiftRecord(program, {
        program,
        macrocycleNum,
        workoutNum,
        date,
        lift,
        ...withOccurrence(occurrence),
        setNum: set.setNum,
        weight,
        reps,
        notes: notesInput || undefined,
        ...(sent.length > 0 && { modifications: sent }),
      }, macrocycleId);
      clearDraft(draftStorageKey);
      onLogged(record);
    } catch (err) {
      logClientError('createLiftRecord', err, {
        program,
        macrocycleNum,
        workoutNum,
        lift,
        setNum: set.setNum,
      });
      // A renumbered macrocycle reloads at its new number; the draft goes with it (#1198).
      if (followMovedMacrocycle(err)) return;
      // The draft stays, so the lifter logs the same set again once the toggles are fresh.
      const stale = await staleModificationMessage(err, sent, onRefreshModifications);
      setError(stale ?? writeFailureMessage(err, 'Failed to log set. Try again.'));
      setSubmitting(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!loggedRecord) return;
    const weight = Number(weightInput);
    const reps = Number(repsInput);
    if (isNaN(weight) || weight < 0 || isNaN(reps) || reps <= 0) {
      setError('Enter valid weight and reps.');
      return;
    }
    setError(null);
    setSubmitting(true);
    // Sent only when changed, so an edit that leaves them alone sends what it always did. An
    // empty list clears them.
    const before = modificationIds(loggedRecord);
    const changed =
      editModifications.length !== before.length || editModifications.some((id) => !before.includes(id));
    const sent = changed ? [...editModifications] : [];
    try {
      const record = await updateLiftRecord(program, loggedRecord.id, {
        weight,
        reps,
        notes: notesInput || undefined,
        ...(changed && { modifications: sent }),
      }, macrocycleId);
      onEditSave(record);
    } catch (err) {
      logClientError('updateLiftRecord', err, { program, id: loggedRecord.id });
      if (followMovedMacrocycle(err)) return;
      const stale = await staleModificationMessage(err, sent, onRefreshModifications);
      setError(stale ?? writeFailureMessage(err, 'Failed to save changes. Try again.'));
      setSubmitting(false);
    }
  }

  // Editing shows the lift's toggles, plus any the set names that are no longer listed (archived),
  // so the lifter can take them off. None when the lift's list didn't load.
  const editChoices = modifications
    ? [
        ...modifications,
        ...(loggedRecord?.modifications ?? [])
          .filter((r) => !modifications.some((m) => m.id === r.id))
          .map((r) => ({ id: r.id, name: r.name, description: '', maxMode: 'none' as const })),
      ]
    : [];

  if (isReadOnly || isLogged) {
    const displayWeight = loggedRecord
      ? formatWorkingWeight(loggedRecord.weight, null, false, unit).display
      : formatWorkingWeight(set.totalLoad, bodyWeight, isBodyweightComponent, unit).display;
    return (
      <li className={`${styles.setRow} ${styles.setRowLogged}`}>
        <span className={styles.setNum}>Set {set.setNum}</span>
        <span className={styles.setCheck}>✓</span>
        <span className={styles.setSummary}>
          {loggedRecord
            ? `${formatWeight(loggedRecord.weight, 'lbs', unit)} × ${loggedRecord.reps}`
            : `${displayWeight} × ${set.reps}`}
          {modificationSuffix(loggedRecord)}
          {set.amrap ? ' (AMRAP)' : ''}
        </span>
        {loggedRecord?.notes && (
          <span className={styles.setNotes}>{loggedRecord.notes}</span>
        )}
        {!isReadOnly && (
          <button
            className={styles.editBtn}
            type="button"
            onClick={handleEditStart}
            aria-label={`Edit set ${set.setNum}`}
          >
            Edit
          </button>
        )}
      </li>
    );
  }

  const isEdit = isEditing && !!loggedRecord;
  return (
    <li className={styles.setRow}>
      <form
        className={styles.setForm}
        onSubmit={isEdit ? handleSave : handleLog}
      >
        <span className={styles.setNum}>Set {set.setNum}</span>
        {set.amrap && <span className={styles.amrapBadge}>AMRAP</span>}
        <label className={styles.srOnly} htmlFor={`weight-${lift}-${set.setNum}`}>
          Weight (lbs)
        </label>
        <input
          id={`weight-${lift}-${set.setNum}`}
          className={styles.setInput}
          type="number"
          min="0"
          step="2.5"
          value={weightInput}
          onChange={(e) => handleWeightInputChange(e.target.value)}
          disabled={submitting}
          aria-label="Weight in lbs"
        />
        <span className={styles.inputSep}>lbs ×</span>
        <label className={styles.srOnly} htmlFor={`reps-${lift}-${set.setNum}`}>
          Reps
        </label>
        <input
          id={`reps-${lift}-${set.setNum}`}
          className={styles.setInput}
          type="number"
          min="0"
          step="1"
          value={repsInput}
          onChange={(e) => handleRepsInputChange(e.target.value)}
          disabled={submitting}
          aria-label="Reps"
        />
        <label className={styles.srOnly} htmlFor={`notes-${lift}-${set.setNum}`}>
          Notes (optional)
        </label>
        <input
          id={`notes-${lift}-${set.setNum}`}
          className={styles.notesInput}
          type="text"
          placeholder="Notes (optional)"
          value={notesInput}
          onChange={(e) => handleNotesInputChange(e.target.value)}
          disabled={submitting}
        />
        {isEdit && editChoices.length > 0 && (
          <ModificationToggles
            label={`Set ${set.setNum} modifications`}
            modifications={editChoices}
            active={editModifications}
            disabled={submitting}
            onToggle={(id) => setEditModifications((ids) => toggleModification(ids, id, editChoices))}
          />
        )}
        {error && <p className={styles.setError}>{error}</p>}
        <button
          className={styles.logBtn}
          type="submit"
          disabled={submitting}
        >
          {submitting ? '…' : isEdit ? 'Save' : 'Log'}
        </button>
        {isEdit && (
          <button
            className={styles.cancelBtn}
            type="button"
            onClick={() => onEditSave(loggedRecord!)}
            disabled={submitting}
          >
            Cancel
          </button>
        )}
        {/* Entry stays in lbs; show the preferred-unit equivalent as a read-only hint. */}
        {unit !== 'lbs' && weightInput !== '' && !isNaN(Number(weightInput)) && (
          <span className={styles.conversionHint}>
            ≈ {formatWeight(Number(weightInput), 'lbs', unit)}
          </span>
        )}
      </form>
    </li>
  );
}

function LiftView({
  lift,
  bodyWeight,
  isReadOnly,
  loggedSets,
  editingSet,
  program,
  macrocycleNum,
  macrocycleId,
  workoutNum,
  date,
  unit,
  modifications,
  activeModifications,
  onToggleModification,
  onModificationAdded,
  onRefreshModifications,
  onLogged,
  onEditStart,
  onEditSave,
}: {
  lift: LiftData;
  bodyWeight: number | null;
  isReadOnly: boolean;
  loggedSets: Map<string, LoggedSet>;
  editingSet: string | null;
  program: string;
  macrocycleNum: number;
  macrocycleId: string | undefined;
  workoutNum: number;
  date: string;
  unit: WeightUnit;
  /** The lift's modifications; `null` when the fetch failed and absent while it runs, both hiding the toggles. */
  modifications: readonly LiftModificationResponse[] | null | undefined;
  activeModifications: readonly string[];
  onToggleModification: (id: string) => void;
  onModificationAdded: (modification: LiftModificationResponse) => void;
  onRefreshModifications: () => Promise<LiftModificationResponse[] | null>;
  onLogged: (key: string, record: LoggedSet) => void;
  onEditStart: (key: string) => void;
  onEditSave: (key: string, record: LoggedSet) => void;
}) {
  return (
    <div className={styles.liftView}>
      <h2 className={styles.liftName}>{lift.lift}</h2>
      {lift.focus && (
        <p className={styles.focusTag}>
          Focus work · {lift.focus.area} · {lift.focus.summary}
        </p>
      )}

      {/* The toggles apply to this occurrence's sets not yet logged (#1152). */}
      {!isReadOnly && modifications && (
        <ModificationToggles
          label={`${lift.lift} modifications`}
          modifications={modifications}
          active={activeModifications}
          onToggle={onToggleModification}
        >
          <AddModification program={program} lift={lift.lift} onAdded={onModificationAdded} />
        </ModificationToggles>
      )}

      {lift.warmUpSets.length > 0 && (
        <section className={styles.warmUpSection} aria-label="Warm-up sets">
          {lift.warmUpImplement && (
            <p className={styles.warmUpImplement}>
              Warm-up on: <strong>{lift.warmUpImplement}</strong>
            </p>
          )}
          <ul className={styles.warmUpList}>
            {lift.warmUpSets.map((s, i) => (
              <WarmUpRow
                key={i}
                label={`Warm-up ${i + 1}`}
                totalLoad={s.totalLoad}
                reps={s.reps}
                bodyWeight={bodyWeight}
                isBodyweightComponent={lift.isBodyweightComponent}
                unit={unit}
              />
            ))}
          </ul>
        </section>
      )}

      <section className={styles.workingSection} aria-label="Working sets">
        <ul className={styles.setList}>
          {lift.workingSets.map((ws) => {
            const key = setKey(lift, ws.setNum);
            return (
              <WorkingSetRow
                key={key}
                lift={lift.lift}
                occurrence={lift.occurrence}
                set={ws}
                bodyWeight={bodyWeight}
                isBodyweightComponent={lift.isBodyweightComponent}
                isReadOnly={isReadOnly}
                loggedRecord={loggedSets.get(key)}
                isEditing={editingSet === key}
                program={program}
                macrocycleNum={macrocycleNum}
                macrocycleId={macrocycleId}
                workoutNum={workoutNum}
                date={date}
                unit={unit}
                modifications={modifications}
                activeModifications={activeModifications}
                onRefreshModifications={onRefreshModifications}
                onLogged={(record) => onLogged(key, record)}
                onEditStart={() => onEditStart(key)}
                onEditSave={(record) => onEditSave(key, record)}
              />
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function OverviewRow({
  lift,
  bodyWeight,
  loggedSets,
  unit,
  onGoTo,
}: {
  lift: LiftData;
  bodyWeight: number | null;
  loggedSets: Map<string, LoggedSet>;
  unit: WeightUnit;
  onGoTo: () => void;
}) {
  const logged = lift.workingSets.filter((ws) =>
    loggedSets.has(setKey(lift, ws.setNum)),
  ).length;
  const total = lift.workingSets.length;
  const firstWarmUp = lift.warmUpSets[0];
  return (
    <li className={styles.overviewRow}>
      <div className={styles.overviewRowHeader}>
        <strong className={styles.overviewLiftName}>{lift.lift}</strong>
        {lift.focus && <span className={styles.focusTag}>Focus · {lift.focus.area}</span>}
        <span className={styles.overviewProgress}>
          {logged}/{total} sets
        </span>
        <button className={styles.goToBtn} type="button" onClick={onGoTo}>
          {logged === total ? 'Review' : logged > 0 ? 'Resume' : 'Go to'}
        </button>
      </div>
      {firstWarmUp && (
        <p className={styles.overviewWarmUp}>
          Warm-up:{' '}
          {formatWarmUpWeight(
            firstWarmUp.totalLoad,
            bodyWeight,
            lift.isBodyweightComponent,
            unit,
          )}{' '}
          × {firstWarmUp.reps}
          {lift.warmUpSets.length > 1 ? ` (+${lift.warmUpSets.length - 1} more)` : ''}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function WorkoutLogger({
  program,
  macrocycleNum,
  macrocycleId,
  workoutNum,
  date,
  lifts,
  hasBodyweightComponent,
  isReadOnly,
  initialBodyWeight,
  unit,
}: WorkoutLoggerProps) {
  const router = useRouter();

  // Editable date — initialized from the server-provided scheduled date, user can override.
  const [effectiveDate, setEffectiveDate] = useState(date);
  useEffect(() => { setEffectiveDate(date); }, [date]);
  // A failed date change on a logged workout: it's put back, and this says why.
  const [dateError, setDateError] = useState<string | null>(null);

  // Initialize loggedSets from any pre-existing records passed via server props
  const [loggedSets, setLoggedSets] = useState<Map<string, LoggedSet>>(
    () => {
      const m = new Map<string, LoggedSet>();
      for (const lift of lifts) {
        for (const ws of lift.workingSets) {
          if (ws.existing) {
            m.set(setKey(lift, ws.setNum), ws.existing);
          }
        }
      }
      return m;
    },
  );
  const [editingSet, setEditingSet] = useState<string | null>(null);
  const [currentLiftIdx, setCurrentLiftIdx] = useState(0);
  const [viewMode, setViewMode] = useState<'per-lift' | 'overview'>('per-lift');
  // initialBodyWeight is non-null (and in lbs) when the server found a same-day body weight entry.
  const [bodyWeight, setBodyWeight] = useState<number | null>(initialBodyWeight);
  const [bodyWeightDone, setBodyWeightDone] = useState(
    !hasBodyweightComponent || isReadOnly || initialBodyWeight !== null,
  );

  async function handleBodyWeightSubmit(weight: number) {
    // The gate collects body weight in the preferred unit, and body-weight records
    // persist a per-record unit, so save it as entered. Keep the in-memory bodyWeight
    // in lbs, though — every added-load calculation subtracts it from an lbs plan load.
    await recordBodyWeight(program, {
      date: effectiveDate,
      weight,
      unit,
    });
    setBodyWeight(convertWeight(weight, unit, 'lbs'));
    setBodyWeightDone(true);
  }

  // Each lift's modifications by lift name, read client-side so a stale toggle can refresh
  // without a reload (#1152). `null` means the fetch failed: the toggles hide and sets still log.
  // A lift is absent until its fetch returns.
  const [modificationsByLift, setModificationsByLift] = useState<
    ReadonlyMap<string, LiftModificationResponse[] | null>
  >(new Map());
  // The toggles the lifter changed, by lift occurrence. One not changed starts from its last
  // logged set, then a toggle saved before its first set, then off (`startingModifications`).
  const [toggled, setToggled] = useState<ReadonlyMap<string, string[]>>(new Map());

  // One read per lift in the workout. A read-only workout shows no toggles, so it reads nothing.
  const liftNames = [...new Set(lifts.map((l) => l.lift))].join('\n');
  useEffect(() => {
    if (isReadOnly) return;
    let cancelled = false;
    for (const lift of liftNames.split('\n')) {
      fetchLiftModifications(lift).then(
        (list) => {
          if (!cancelled) setModificationsByLift((prev) => new Map(prev).set(lift, list));
        },
        (err: unknown) => {
          logClientError('fetchLiftModifications', err, { program, lift });
          if (!cancelled) setModificationsByLift((prev) => new Map(prev).set(lift, null));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [isReadOnly, liftNames, program]);

  async function refreshModifications(lift: string): Promise<LiftModificationResponse[] | null> {
    try {
      const list = await fetchLiftModifications(lift);
      setModificationsByLift((prev) => new Map(prev).set(lift, list));
      return list;
    } catch (err) {
      // The toggles already showing stay; the set's own error says it didn't log.
      logClientError('fetchLiftModifications', err, { program, lift });
      return null;
    }
  }

  function modificationsDraftKey(lift: LiftData): string {
    return buildModificationsDraftKey(program, macrocycleNum, workoutNum, lift.lift, lift.occurrence, macrocycleId);
  }

  function startingModifications(lift: LiftData): string[] {
    const lastLogged = [...lift.workingSets]
      .reverse()
      .map((ws) => loggedSets.get(setKey(lift, ws.setNum)))
      .find((record) => record !== undefined);
    return lastLogged ? modificationIds(lastLogged) : (readModificationsDraft(modificationsDraftKey(lift)) ?? []);
  }

  /** The ids on for a lift occurrence's next set, limited to the modifications still listed. */
  function activeModifications(lift: LiftData): string[] {
    const listed = modificationsByLift.get(lift.lift);
    if (!listed) return [];
    const chosen = toggled.get(liftKey(lift)) ?? startingModifications(lift);
    return chosen.filter((id) => listed.some((m) => m.id === id));
  }

  function setActiveModifications(lift: LiftData, ids: string[]) {
    setToggled((prev) => new Map(prev).set(liftKey(lift), ids));
    writeModificationsDraft(modificationsDraftKey(lift), ids);
  }

  function handleToggleModification(lift: LiftData, id: string) {
    setActiveModifications(lift, toggleModification(activeModifications(lift), id, modificationsByLift.get(lift.lift) ?? []));
  }

  // A modification added mid-workout joins the lift's list and is turned on for this occurrence.
  function handleModificationAdded(lift: LiftData, modification: LiftModificationResponse) {
    const listed = [...(modificationsByLift.get(lift.lift) ?? []), modification];
    setModificationsByLift((prev) => new Map(prev).set(lift.lift, listed));
    setActiveModifications(lift, toggleModification(activeModifications(lift), modification.id, listed));
  }

  function handleLogged(key: string, record: LoggedSet) {
    setLoggedSets((prev) => new Map(prev).set(key, record));
    setEditingSet(null);
  }

  function handleEditStart(key: string) {
    setEditingSet(key);
  }

  function handleEditSave(key: string, record: LoggedSet) {
    setLoggedSets((prev) => new Map(prev).set(key, record));
    setEditingSet(null);
  }

  // Every planned set logged. Focus sets (#1060) don't hold up finishing: focus work is
  // extra, and a lifter who skips it today still finishes the workout.
  const plannedLifts = lifts.filter((l) => !l.focus);
  const allLogged =
    plannedLifts.some((l) => l.workingSets.length > 0) &&
    plannedLifts.every((l) => l.workingSets.every((ws) => loggedSets.has(setKey(l, ws.setNum))));

  // Per-set clearDraft (in WorkingSetRow's handleLog) can't reach a draft written on a
  // different tab/device than the one that logged the set — sweep the whole workout's
  // drafts here as a backstop before leaving the page.
  function handleFinishWorkout() {
    for (const l of lifts) {
      clearDraft(modificationsDraftKey(l));
      for (const ws of l.workingSets) {
        clearDraft(buildDraftKey(program, macrocycleNum, workoutNum, l.lift, ws.setNum, l.occurrence, macrocycleId));
        clearDraft(buildDraftKey(program, macrocycleNum, workoutNum, l.lift, ws.setNum, l.occurrence));
      }
    }
    router.push(`/macrocycle/${macrocycleNum}`);
  }

  // Body weight gate
  if (!bodyWeightDone) {
    return <BodyWeightGate onSubmit={handleBodyWeightSubmit} unit={unit} />;
  }

  const currentLift = lifts[currentLiftIdx];
  const nextLift = lifts[currentLiftIdx + 1];

  // Overview mode
  if (viewMode === 'overview') {
    return (
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.screenTitle}>Workout {workoutNum}</h1>
          <button
            className={styles.viewToggle}
            type="button"
            aria-label="Switch to per-lift view"
            onClick={() => setViewMode('per-lift')}
          >
            ✕
          </button>
        </header>
        <ul className={styles.overviewList}>
          {lifts.map((lift, i) => (
            <OverviewRow
              key={liftKey(lift)}
              lift={lift}
              bodyWeight={bodyWeight}
              loggedSets={loggedSets}
              unit={unit}
              onGoTo={() => {
                setCurrentLiftIdx(i);
                setViewMode('per-lift');
              }}
            />
          ))}
        </ul>
        {allLogged && (
          <button
            className={styles.finishBtn}
            type="button"
            onClick={handleFinishWorkout}
          >
            Finish workout
          </button>
        )}
      </div>
    );
  }

  // Per-lift view
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.screenTitle}>Workout {workoutNum}</h1>
        <button
          className={styles.viewToggle}
          type="button"
          aria-label="Switch to overview"
          onClick={() => setViewMode('overview')}
        >
          ⊞
        </button>
      </header>

      <div className={styles.dateRow}>
        <label className={styles.dateLabel} htmlFor="workout-date">
          Date
        </label>
        <input
          id="workout-date"
          className={styles.dateInput}
          type="date"
          value={effectiveDate}
          onChange={(e) => {
            const newDate = e.target.value;
            const prevDate = effectiveDate;
            setEffectiveDate(newDate);
            setDateError(null);
            if (isReadOnly) {
              rescheduleWorkout(program, macrocycleNum, workoutNum, newDate, macrocycleId).catch((err) => {
                logClientError('rescheduleWorkout', err, { program, macrocycleNum, workoutNum });
                if (followMovedMacrocycle(err)) return;
                setEffectiveDate(prevDate);
                setDateError(writeFailureMessage(err, 'Failed to change the date. Try again.'));
              });
            }
          }}
        />
        {dateError && <p className={styles.setError}>{dateError}</p>}
      </div>

      {/* Navigation dots */}
      <nav className={styles.navDots} aria-label="Lift navigation">
        {lifts.map((lift, i) => {
          const liftLogged = lift.workingSets.every((ws) =>
            loggedSets.has(setKey(lift, ws.setNum)),
          );
          return (
            <button
              key={liftKey(lift)}
              className={`${styles.dot} ${i === currentLiftIdx ? styles.dotActive : ''} ${liftLogged ? styles.dotDone : ''}`}
              type="button"
              aria-label={`Go to ${lift.lift}`}
              aria-current={i === currentLiftIdx ? 'true' : undefined}
              onClick={() => setCurrentLiftIdx(i)}
            />
          );
        })}
      </nav>

      {/* Current lift */}
      {currentLift && (
        <LiftView
          lift={currentLift}
          bodyWeight={bodyWeight}
          isReadOnly={isReadOnly}
          loggedSets={loggedSets}
          editingSet={editingSet}
          program={program}
          macrocycleNum={macrocycleNum}
          macrocycleId={macrocycleId}
          workoutNum={workoutNum}
          date={effectiveDate}
          unit={unit}
          modifications={modificationsByLift.get(currentLift.lift)}
          activeModifications={activeModifications(currentLift)}
          onToggleModification={(id) => handleToggleModification(currentLift, id)}
          onModificationAdded={(modification) => handleModificationAdded(currentLift, modification)}
          onRefreshModifications={() => refreshModifications(currentLift.lift)}
          onLogged={handleLogged}
          onEditStart={handleEditStart}
          onEditSave={handleEditSave}
        />
      )}

      {/* Bottom strip */}
      <footer className={styles.bottomStrip}>
        {nextLift ? (
          <>
            <span className={styles.nextLabel}>Next:</span>
            <span className={styles.nextName}>{nextLift.lift}</span>
            {nextLift.warmUpSets[0] && (
              <span className={styles.nextWeight}>
                {formatWarmUpWeight(
                  nextLift.warmUpSets[0].totalLoad,
                  bodyWeight,
                  nextLift.isBodyweightComponent,
                  unit,
                )}{' '}
                × {nextLift.warmUpSets[0].reps}
              </span>
            )}
            <button
              className={styles.nextBtn}
              type="button"
              onClick={() => setCurrentLiftIdx((i) => i + 1)}
            >
              →
            </button>
          </>
        ) : (
          <span className={styles.lastExercise}>Last lift</span>
        )}
        {allLogged && (
          <button
            className={styles.finishBtn}
            type="button"
            onClick={handleFinishWorkout}
          >
            Finish workout
          </button>
        )}
      </footer>
    </div>
  );
}
