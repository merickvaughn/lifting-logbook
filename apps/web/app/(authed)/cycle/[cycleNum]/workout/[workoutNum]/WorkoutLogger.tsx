'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { LiftRecordResponse, WeightUnit } from '@lifting-logbook/types';
import { convertWeight, formatWeight, roundToDisplay } from '@lifting-logbook/core';
import {
  createLiftRecord,
  recordBodyWeight,
  rescheduleWorkout,
  updateLiftRecord,
} from '@/lib/client-api';
import { logClientError } from '@/lib/log-client-error';
import styles from './WorkoutLogger.module.css';
import type { LiftData, WorkingSetData, WorkoutLoggerProps } from './types';
import { buildDraftKey, clearDraft, readDraft, writeDraft } from './workoutDraftStorage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        This workout includes bodyweight exercises. Enter your weight to
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
  set,
  bodyWeight,
  isBodyweightComponent,
  isReadOnly,
  loggedRecord,
  isEditing,
  program,
  cycleNum,
  workoutNum,
  date,
  unit,
  onLogged,
  onEditStart,
  onEditSave,
}: {
  lift: string;
  set: WorkingSetData;
  bodyWeight: number | null;
  isBodyweightComponent: boolean;
  isReadOnly: boolean;
  loggedRecord?: LiftRecordResponse;
  isEditing: boolean;
  program: string;
  cycleNum: number;
  workoutNum: number;
  date: string;
  unit: WeightUnit;
  onLogged: (record: LiftRecordResponse) => void;
  onEditStart: () => void;
  onEditSave: (record: LiftRecordResponse) => void;
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
  const draftStorageKey = buildDraftKey(program, cycleNum, workoutNum, lift, set.setNum);

  const [weightInput, setWeightInput] = useState(() => {
    if (shouldDraft) {
      const draft = readDraft(draftStorageKey);
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

  const isLogged = !!loggedRecord && !isEditing;

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
    try {
      const record = await createLiftRecord(program, {
        program,
        cycleNum,
        workoutNum,
        date,
        lift,
        setNum: set.setNum,
        weight,
        reps,
        notes: notesInput || undefined,
      });
      clearDraft(draftStorageKey);
      onLogged(record);
    } catch (err) {
      logClientError('createLiftRecord', err, {
        program,
        cycleNum,
        workoutNum,
        lift,
        setNum: set.setNum,
      });
      setError('Failed to log set. Try again.');
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
    try {
      const record = await updateLiftRecord(program, loggedRecord.id, {
        weight,
        reps,
        notes: notesInput || undefined,
      });
      onEditSave(record);
    } catch (err) {
      logClientError('updateLiftRecord', err, { program, id: loggedRecord.id });
      setError('Failed to save changes. Try again.');
      setSubmitting(false);
    }
  }

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
          {set.amrap ? ' (AMRAP)' : ''}
        </span>
        {loggedRecord?.notes && (
          <span className={styles.setNotes}>{loggedRecord.notes}</span>
        )}
        {!isReadOnly && (
          <button
            className={styles.editBtn}
            type="button"
            onClick={onEditStart}
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
  cycleNum,
  workoutNum,
  date,
  unit,
  onLogged,
  onEditStart,
  onEditSave,
}: {
  lift: LiftData;
  bodyWeight: number | null;
  isReadOnly: boolean;
  loggedSets: Map<string, LiftRecordResponse>;
  editingSet: string | null;
  program: string;
  cycleNum: number;
  workoutNum: number;
  date: string;
  unit: WeightUnit;
  onLogged: (key: string, record: LiftRecordResponse) => void;
  onEditStart: (key: string) => void;
  onEditSave: (key: string, record: LiftRecordResponse) => void;
}) {
  return (
    <div className={styles.liftView}>
      <h2 className={styles.liftName}>{lift.lift}</h2>

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
            const key = `${lift.lift}-${ws.setNum}`;
            return (
              <WorkingSetRow
                key={key}
                lift={lift.lift}
                set={ws}
                bodyWeight={bodyWeight}
                isBodyweightComponent={lift.isBodyweightComponent}
                isReadOnly={isReadOnly}
                loggedRecord={loggedSets.get(key)}
                isEditing={editingSet === key}
                program={program}
                cycleNum={cycleNum}
                workoutNum={workoutNum}
                date={date}
                unit={unit}
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
  loggedSets: Map<string, LiftRecordResponse>;
  unit: WeightUnit;
  onGoTo: () => void;
}) {
  const logged = lift.workingSets.filter((ws) =>
    loggedSets.has(`${lift.lift}-${ws.setNum}`),
  ).length;
  const total = lift.workingSets.length;
  const firstWarmUp = lift.warmUpSets[0];
  return (
    <li className={styles.overviewRow}>
      <div className={styles.overviewRowHeader}>
        <strong className={styles.overviewLiftName}>{lift.lift}</strong>
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
  cycleNum,
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

  // Initialize loggedSets from any pre-existing records passed via server props
  const [loggedSets, setLoggedSets] = useState<Map<string, LiftRecordResponse>>(
    () => {
      const m = new Map<string, LiftRecordResponse>();
      for (const lift of lifts) {
        for (const ws of lift.workingSets) {
          if (ws.existing) {
            m.set(`${lift.lift}-${ws.setNum}`, ws.existing);
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

  function handleLogged(key: string, record: LiftRecordResponse) {
    setLoggedSets((prev) => new Map(prev).set(key, record));
    setEditingSet(null);
  }

  function handleEditStart(key: string) {
    setEditingSet(key);
  }

  function handleEditSave(key: string, record: LiftRecordResponse) {
    setLoggedSets((prev) => new Map(prev).set(key, record));
    setEditingSet(null);
  }

  // Total sets logged across all lifts
  const totalSets = lifts.reduce((n, l) => n + l.workingSets.length, 0);
  const allLogged = loggedSets.size === totalSets && totalSets > 0;

  // Per-set clearDraft (in WorkingSetRow's handleLog) can't reach a draft written on a
  // different tab/device than the one that logged the set — sweep the whole workout's
  // drafts here as a backstop before leaving the page.
  function handleFinishWorkout() {
    for (const l of lifts) {
      for (const ws of l.workingSets) {
        clearDraft(buildDraftKey(program, cycleNum, workoutNum, l.lift, ws.setNum));
      }
    }
    router.push(`/cycle/${cycleNum}`);
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
            aria-label="Switch to per-exercise view"
            onClick={() => setViewMode('per-lift')}
          >
            ✕
          </button>
        </header>
        <ul className={styles.overviewList}>
          {lifts.map((lift, i) => (
            <OverviewRow
              key={lift.lift}
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
            if (isReadOnly) {
              rescheduleWorkout(program, cycleNum, workoutNum, newDate).catch((err) => {
                logClientError('rescheduleWorkout', err, { program, cycleNum, workoutNum });
                setEffectiveDate(prevDate);
              });
            }
          }}
        />
      </div>

      {/* Navigation dots */}
      <nav className={styles.navDots} aria-label="Exercise navigation">
        {lifts.map((lift, i) => {
          const liftLogged = lift.workingSets.every((ws) =>
            loggedSets.has(`${lift.lift}-${ws.setNum}`),
          );
          return (
            <button
              key={lift.lift}
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
          cycleNum={cycleNum}
          workoutNum={workoutNum}
          date={effectiveDate}
          unit={unit}
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
          <span className={styles.lastExercise}>Last exercise</span>
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
