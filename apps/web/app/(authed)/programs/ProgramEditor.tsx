'use client';

import { useState, useTransition } from 'react';
import { LIFT_CATALOG } from '@lifting-logbook/core';
import { useRouter } from 'next/navigation';
import { DEFAULT_WEIGHT_INCREMENT } from '@lifting-logbook/types';
import type { CustomProgramResponse, CustomProgramSpecRow } from '@lifting-logbook/types';
import { createCustomProgram, updateCustomProgram, switchProgram } from './actions';
import { templateSeedSpecs } from '@/lib/programs';
import {
  MAX_DAYS,
  MAX_INSTANCES_PER_DAY,
  WEEKS,
  daysFromSpecs,
  defaultWeeks,
  specsFromDays,
  uid,
  type EditableWeek,
  type WeekParams,
  type WorkoutDayModel,
} from './programSpecMapping';
import styles from './programs.module.css';

type Mode = 'new' | 'clone' | 'edit';

type Props = {
  mode: Mode;
  existing?: CustomProgramResponse;
  baseTemplateId?: string;
  activeProgram: string | null;
  defaultWeightIncrement: number | null;
  onSaved: (id: string) => void;
  onCancel: () => void;
};

const WEEK_LABELS: Record<EditableWeek, string> = {
  1: 'Week 1',
  2: 'Week 2',
  3: 'Week 3',
};

const ALL_LIFTS: string[] = LIFT_CATALOG.map((l) => l.name as string);

export default function ProgramEditor({
  mode,
  existing,
  baseTemplateId,
  activeProgram: _activeProgram,
  defaultWeightIncrement,
  onSaved,
  onCancel,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Seeds new instances (custom programs only — see docs/standards/training-max-precision.md).
  // Clone templates carry their own per-lift increments via templateSeedSpecs; this is the
  // fallback for lifts added by hand.
  const increment = defaultWeightIncrement ?? DEFAULT_WEIGHT_INCREMENT;

  const [name, setName] = useState(
    mode === 'edit' ? (existing?.name ?? '') : mode === 'clone' ? `${existing?.name ?? ''} (copy)` : '',
  );
  const [description, setDescription] = useState(
    mode === 'edit' ? (existing?.description ?? '') : '',
  );

  const [days, setDays] = useState<WorkoutDayModel[]>(() => {
    // Load an existing program's specs whenever they are provided, regardless of
    // mode — so a future "clone an existing custom program" flow (which would pass
    // `existing` under mode="clone") starts from the source specs instead of empty.
    if (existing?.specs && existing.specs.length > 0) {
      return daysFromSpecs(existing.specs);
    }
    if (mode === 'clone' && baseTemplateId) {
      const seeded = daysFromSpecs(templateSeedSpecs(baseTemplateId));
      if (seeded.length > 0) return seeded;
    }
    // New program (or a clone of a template with no registered builder): start
    // with one empty day so there is somewhere to add the first exercise.
    return [{ id: uid(), instances: [] }];
  });

  function addDay() {
    setDays((prev) => (prev.length >= MAX_DAYS ? prev : [...prev, { id: uid(), instances: [] }]));
  }

  function removeDay(dayId: string) {
    setDays((prev) => prev.filter((d) => d.id !== dayId));
  }

  function addInstance(dayId: string, lift: string) {
    if (!lift) return;
    setDays((prev) =>
      prev.map((d) =>
        d.id !== dayId
          ? d
          : d.instances.length >= MAX_INSTANCES_PER_DAY
            ? d
            : { ...d, instances: [...d.instances, { id: uid(), lift, weeks: defaultWeeks(increment) }] },
      ),
    );
  }

  function removeInstance(dayId: string, instId: string) {
    setDays((prev) =>
      prev.map((d) => (d.id !== dayId ? d : { ...d, instances: d.instances.filter((i) => i.id !== instId) })),
    );
  }

  function updateInstanceWeek(
    dayId: string,
    instId: string,
    week: EditableWeek,
    field: keyof WeekParams,
    value: number | boolean | string,
  ) {
    setDays((prev) =>
      prev.map((d) =>
        d.id !== dayId
          ? d
          : {
              ...d,
              instances: d.instances.map((inst) =>
                inst.id !== instId
                  ? inst
                  : {
                      ...inst,
                      weeks: { ...inst.weeks, [week]: { ...inst.weeks[week], [field]: value } },
                    },
              ),
            },
      ),
    );
  }

  // Validates name + at least one exercise and returns the spec rows, or null
  // (with an error set) when invalid. Uniqueness of (week, offset, lift, order)
  // is guaranteed by construction — offset is the day index and order is the
  // within-day position — so no duplicate-key guard is needed here.
  function collectSpecs(): CustomProgramSpecRow[] | null {
    if (!name.trim()) {
      setError('Name is required.');
      return null;
    }
    const specs = specsFromDays(days);
    if (specs.length === 0) {
      setError('Add at least one lift to a workout day.');
      return null;
    }
    setError(null);
    return specs;
  }

  async function persist(specs: CustomProgramSpecRow[]): Promise<CustomProgramResponse> {
    if (mode === 'edit' && existing) {
      return updateCustomProgram(existing.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        specs,
      });
    }
    return createCustomProgram({
      name: name.trim(),
      description: description.trim() || undefined,
      baseTemplate: baseTemplateId,
      specs,
    });
  }

  function handleSave() {
    const specs = collectSpecs();
    if (!specs) return;
    startTransition(async () => {
      try {
        const saved = await persist(specs);
        onSaved(saved.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save program.');
      }
    });
  }

  function handleSaveAndSwitch() {
    const specs = collectSpecs();
    if (!specs) return;
    startTransition(async () => {
      try {
        const saved = await persist(specs);
        const result = await switchProgram(saved.id);
        router.push(`/macrocycle/${result.macrocycleNum}`);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save or switch program.');
      }
    });
  }

  return (
    <div className={styles.editorForm}>
      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor="prog-name">Program Name</label>
        <input
          id="prog-name"
          className={styles.formInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Custom 5/3/1"
        />
      </div>

      <div className={styles.formField}>
        <label className={styles.formLabel} htmlFor="prog-desc">Description (optional)</label>
        <textarea
          id="prog-desc"
          className={styles.formTextarea}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe your program…"
        />
      </div>

      <div className={styles.formField}>
        <p className={styles.formLabel}>Workout Days</p>
        <p className={styles.infoText}>
          Group lifts into workout days. Add a lift to more than one day to train it
          multiple times in a week.
        </p>

        {days.map((day, dayIdx) => {
          const n = dayIdx + 1;
          return (
            <div key={day.id} className={styles.dayCard} role="group" aria-label={`Day ${n}`}>
              <div className={styles.dayHeader}>
                <span className={styles.dayTitle}>Day {n}</span>
                <button
                  type="button"
                  className={styles.btnDanger}
                  aria-label={`Remove Day ${n}`}
                  onClick={() => removeDay(day.id)}
                >
                  Remove Day
                </button>
              </div>

              {day.instances.length === 0 ? (
                <p className={styles.infoText}>No lifts yet — add one below.</p>
              ) : (
                day.instances.map((inst, i) => (
                  <div key={inst.id} className={styles.instanceRow}>
                    <div className={styles.instanceHeader}>
                      <strong>{inst.lift}</strong>
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        aria-label={`Remove ${inst.lift} #${i + 1} from Day ${n}`}
                        onClick={() => removeInstance(day.id, inst.id)}
                      >
                        Remove
                      </button>
                    </div>
                    <div className={styles.instanceSpec}>
                      <table className={styles.specTable}>
                        <thead>
                          <tr>
                            <th>Week</th>
                            <th>Sets</th>
                            <th>Reps</th>
                            <th>AMRAP</th>
                            <th>Increment</th>
                            <th>Warmup %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {WEEKS.map((week) => {
                            const p = inst.weeks[week];
                            return (
                              <tr key={week}>
                                <td>{WEEK_LABELS[week]}</td>
                                <td>
                                  <input
                                    className={styles.specInput}
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={p.sets}
                                    aria-label={`${inst.lift} #${i + 1} Day ${n} Week ${week} sets`}
                                    onChange={(e) => updateInstanceWeek(day.id, inst.id, week, 'sets', Number(e.target.value))}
                                  />
                                </td>
                                <td>
                                  <input
                                    className={styles.specInput}
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={p.reps}
                                    aria-label={`${inst.lift} #${i + 1} Day ${n} Week ${week} reps`}
                                    onChange={(e) => updateInstanceWeek(day.id, inst.id, week, 'reps', Number(e.target.value))}
                                  />
                                </td>
                                <td>
                                  <input
                                    type="checkbox"
                                    checked={p.amrap}
                                    aria-label={`${inst.lift} #${i + 1} Day ${n} Week ${week} AMRAP`}
                                    onChange={(e) => updateInstanceWeek(day.id, inst.id, week, 'amrap', e.target.checked)}
                                  />
                                </td>
                                <td>
                                  <input
                                    className={styles.specInput}
                                    type="number"
                                    min={0}
                                    step={2.5}
                                    value={p.increment}
                                    aria-label={`${inst.lift} #${i + 1} Day ${n} Week ${week} increment`}
                                    onChange={(e) => updateInstanceWeek(day.id, inst.id, week, 'increment', Number(e.target.value))}
                                  />
                                </td>
                                <td>
                                  <input
                                    className={styles.specInput}
                                    style={{ width: '120px' }}
                                    type="text"
                                    value={p.warmUpPct}
                                    aria-label={`${inst.lift} #${i + 1} Day ${n} Week ${week} warmup percents`}
                                    onChange={(e) => updateInstanceWeek(day.id, inst.id, week, 'warmUpPct', e.target.value)}
                                    placeholder="0.4,0.5,0.6"
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              )}

              <div className={styles.addExerciseRow}>
                <select
                  className={styles.formSelect}
                  value=""
                  aria-label={`Add lift to Day ${n}`}
                  disabled={day.instances.length >= MAX_INSTANCES_PER_DAY}
                  onChange={(e) => addInstance(day.id, e.target.value)}
                >
                  <option value="" disabled>Add lift…</option>
                  {ALL_LIFTS.map((lift) => (
                    <option key={lift} value={lift}>{lift}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}

        <button
          type="button"
          className={styles.addDayButton}
          onClick={addDay}
          disabled={days.length >= MAX_DAYS}
        >
          + Add Day
        </button>
      </div>

      {error && <p className={styles.errorNote}>{error}</p>}

      <div className={styles.programActions}>
        <button type="button" className={styles.btnSecondary} onClick={onCancel} disabled={isPending}>
          Cancel
        </button>
        <button type="button" className={styles.btnSecondary} onClick={handleSave} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={styles.btnPrimary} onClick={handleSaveAndSwitch} disabled={isPending}>
          {isPending ? 'Saving…' : 'Save & Switch to This Program'}
        </button>
      </div>
    </div>
  );
}
