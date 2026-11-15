'use client';

import { useState } from 'react';
import { convertWeight, evaluateStrengthTier, formatWeight, lookupByStoredId, roundToDisplay } from '@lifting-logbook/core';
import type {
  BodyWeightResponse,
  CustomLiftResponse,
  StrengthGoalResponse,
  TrainingMaxResponse,
  WeightUnit,
} from '@lifting-logbook/types';
import { logClientError } from '@/lib/log-client-error';
import { saveStrengthGoal, removeStrengthGoal, saveBodyWeight } from './actions';

interface Props {
  program: string;
  trainingMaxes: TrainingMaxResponse[];
  goals: StrengthGoalResponse[];
  bodyWeight: BodyWeightResponse | null;
  /** Global display preference — also the default unit for new goal/body-weight entries. */
  preferredUnit: WeightUnit;
  /** A custom lift is stored by its id, so the page names it from here. */
  customLifts: CustomLiftResponse[];
}

interface GoalRowState {
  goalType: 'absolute' | 'relative';
  target: string;
  unit: 'lbs' | 'kg';
  ratio: string;
  saving: boolean;
  error: string | null;
}

// The training max is always stored in lbs (see docs/standards/training-max-precision.md);
// `bw` and `target` are user-facing values in whatever unit is currently selected for each.
// Convert the training max into that unit before comparing so progress is correct regardless
// of which unit the user picked for body weight vs. this specific goal.
//
// Passed as a single options object rather than positional args: `tmUnit`, `bwUnit`, and
// `targetUnit` are all `WeightUnit`, so a positional signature would let two units be
// transposed silently — reintroducing exactly the cross-unit class of bug this function fixes.
interface ProgressArgs {
  tmWeight: number;
  tmUnit: WeightUnit;
  bw: number;
  bwUnit: WeightUnit;
  goalType: 'absolute' | 'relative';
  target: string;
  targetUnit: WeightUnit;
  ratio: string;
}

function computeProgress({
  tmWeight,
  tmUnit,
  bw,
  bwUnit,
  goalType,
  target,
  targetUnit,
  ratio,
}: ProgressArgs): number | null {
  if (goalType === 'relative') {
    const r = parseFloat(ratio);
    if (!isNaN(r) && r > 0 && bw > 0) {
      const tmInBwUnit = convertWeight(tmWeight, tmUnit, bwUnit);
      return evaluateStrengthTier(tmInBwUnit, bw, r).progressRatio;
    }
  } else {
    const t = parseFloat(target);
    if (!isNaN(t) && t > 0) {
      const tmInTargetUnit = convertWeight(tmWeight, tmUnit, targetUnit);
      return tmInTargetUnit / t;
    }
  }
  return null;
}

function targetText(goal: StrengthGoalResponse, preferredUnit: WeightUnit): string {
  if (goal.goalType === 'relative') return goal.ratio !== undefined ? `${goal.ratio}× BW` : '';
  return goal.target !== undefined ? formatWeight(goal.target, goal.unit, preferredUnit) : '';
}

export default function StrengthGoalsForm({
  program,
  trainingMaxes,
  goals,
  bodyWeight,
  preferredUnit,
  customLifts,
}: Props) {
  const [currentBw, setCurrentBw] = useState<number | null>(bodyWeight?.weight ?? null);
  const [currentBwUnit, setCurrentBwUnit] = useState<WeightUnit>(bodyWeight?.unit ?? preferredUnit);
  const [bwInput, setBwInput] = useState(String(bodyWeight?.weight ?? ''));
  const [editingBw, setEditingBw] = useState(false);
  const [savingBw, setSavingBw] = useState(false);
  const [bwError, setBwError] = useState<string | null>(null);

  // The goals stored now, kept as saves and removals land so every lookup below reads them.
  const [storedGoals, setStoredGoals] = useState<StrengthGoalResponse[]>(goals);
  const customNames = new Map(customLifts.map((l) => [l.id, l.name]));
  const nameOf = (lift: string) => customNames.get(lift) ?? lift;

  // A goal and its max can spell the lift differently (#1135), so a row finds its goal
  // through this, and saves and deletes under the goal's own name rather than adding a second.
  const goalFor = lookupByStoredId(storedGoals.map((g) => [g.lift, g] as const));
  // A goal no card reaches (its lift has no max, or the card reads another spelling's goal)
  // is listed under the cards, so it can still be seen and removed (#1179).
  const carded = new Set(trainingMaxes.map((m) => goalFor(m.lift)));
  const uncarded = storedGoals.filter((g) => !carded.has(g));
  const [listed, setListed] = useState<Record<string, { removing: boolean; error: string | null }>>({});
  const initialRows = Object.fromEntries(
    trainingMaxes.map((m) => {
      const existing = goalFor(m.lift);
      return [
        m.lift,
        {
          goalType: (existing?.goalType ?? 'relative') as 'absolute' | 'relative',
          target: String(existing?.target ?? ''),
          unit: (existing?.unit ?? preferredUnit) as 'lbs' | 'kg',
          ratio: String(existing?.ratio ?? ''),
          saving: false,
          error: null,
        } satisfies GoalRowState,
      ];
    }),
  );

  const [rows, setRows] = useState<Record<string, GoalRowState>>(initialRows);

  function updateRow(lift: string, patch: Partial<GoalRowState>) {
    setRows((prev) => ({ ...prev, [lift]: { ...prev[lift], ...patch } }));
  }

  // Two rows can reach one goal (`Bench Press` and `bench-press`), so a save or delete updates
  // both. Otherwise the other row keeps old values, and saving it writes them back.
  function rowsOfGoal(goalLift: string): string[] {
    const reaches = lookupByStoredId([[goalLift, goalLift] as const]);
    return trainingMaxes
      .map((m) => m.lift)
      .filter((lift) => (goalFor(lift)?.lift ?? reaches(lift)) === goalLift);
  }

  function updateRows(lifts: readonly string[], patchFor: (lift: string) => Partial<GoalRowState>) {
    setRows((prev) => ({
      ...prev,
      ...Object.fromEntries(lifts.map((lift) => [lift, { ...prev[lift], ...patchFor(lift) }])),
    }));
  }

  async function handleSaveBw() {
    const w = parseFloat(bwInput);
    if (isNaN(w) || w <= 0) {
      setBwError('Enter a positive number');
      return;
    }
    setSavingBw(true);
    setBwError(null);
    try {
      await saveBodyWeight(program, w, preferredUnit);
      setCurrentBw(w);
      setCurrentBwUnit(preferredUnit);
      setEditingBw(false);
    } catch {
      setBwError('Save failed');
    } finally {
      setSavingBw(false);
    }
  }

  async function handleSave(lift: string) {
    const row = rows[lift];
    if (row.goalType === 'relative') {
      const ratio = parseFloat(row.ratio);
      if (isNaN(ratio) || ratio <= 0) {
        updateRow(lift, { error: 'Enter a positive ratio (e.g. 1.75)' });
        return;
      }
    } else {
      const target = parseFloat(row.target);
      if (isNaN(target) || target <= 0) {
        updateRow(lift, { error: 'Enter a positive target weight' });
        return;
      }
    }
    const goalLift = goalFor(lift)?.lift ?? lift;
    const lifts = rowsOfGoal(goalLift);
    updateRows(lifts, () => ({ saving: true }));
    updateRow(lift, { error: null });
    try {
      const body =
        row.goalType === 'relative'
          ? { goalType: 'relative' as const, ratio: parseFloat(row.ratio), unit: row.unit }
          : { goalType: 'absolute' as const, target: parseFloat(row.target), unit: row.unit };
      await saveStrengthGoal(program, goalLift, body);
      updateRows(lifts, () => ({
        goalType: row.goalType,
        target: row.target,
        unit: row.unit,
        ratio: row.ratio,
      }));
      const saved: StrengthGoalResponse = { ...body, lift: goalLift, updatedAt: new Date().toISOString() };
      setStoredGoals((prev) =>
        prev.some((g) => g.lift === goalLift)
          ? prev.map((g) => (g.lift === goalLift ? saved : g))
          : [...prev, saved],
      );
    } catch {
      updateRow(lift, { error: 'Save failed' });
    } finally {
      updateRows(lifts, () => ({ saving: false }));
    }
  }

  async function handleDelete(lift: string) {
    const goalLift = goalFor(lift)?.lift ?? lift;
    const lifts = rowsOfGoal(goalLift);
    updateRows(lifts, () => ({ saving: true }));
    updateRow(lift, { error: null });
    try {
      await removeStrengthGoal(program, goalLift);
      // A row can then reach another goal for its lift, which is what a reload would show.
      const left = storedGoals.filter((g) => g.lift !== goalLift);
      const remaining = lookupByStoredId(left.map((g) => [g.lift, g] as const));
      setStoredGoals(left);
      updateRows(lifts, (l) => {
        const next = remaining(l);
        return next
          ? {
              goalType: next.goalType,
              target: String(next.target ?? ''),
              unit: next.unit,
              ratio: String(next.ratio ?? ''),
            }
          : { target: '', ratio: '' };
      });
    } catch {
      updateRow(lift, { error: 'Delete failed' });
    } finally {
      updateRows(lifts, () => ({ saving: false }));
    }
  }

  async function handleRemoveListed(goalLift: string) {
    setListed((prev) => ({ ...prev, [goalLift]: { removing: true, error: null } }));
    try {
      await removeStrengthGoal(program, goalLift);
      setStoredGoals((prev) => prev.filter((g) => g.lift !== goalLift));
      setListed((prev) => ({ ...prev, [goalLift]: { removing: false, error: null } }));
    } catch (err) {
      logClientError('removeStrengthGoal', err, { program, lift: goalLift });
      setListed((prev) => ({ ...prev, [goalLift]: { removing: false, error: 'Remove failed' } }));
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '1rem' }}>
      <h1>Strength Goals</h1>

      {/* Body weight */}
      <section style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Body Weight</h2>
        {editingBw ? (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="number"
              value={bwInput}
              onChange={(e) => setBwInput(e.target.value)}
              style={{ width: 80 }}
              aria-label="Body weight"
              autoFocus
            />
            <span>{preferredUnit}</span>
            <button type="button" onClick={handleSaveBw} disabled={savingBw}>
              {savingBw ? '…' : '✓'}
            </button>
            <button type="button" onClick={() => { setEditingBw(false); setBwError(null); }}>
              ✕
            </button>
            {bwError && <span style={{ color: 'red', fontSize: '0.8rem' }}>{bwError}</span>}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.5rem 0.75rem',
              background: '#f8f9fa',
              borderRadius: 6,
              border: '1px solid #ecf0f1',
              cursor: 'pointer',
              width: 'fit-content',
            }}
            onClick={() => {
              setEditingBw(true);
              setBwInput(
                currentBw !== null
                  ? String(roundToDisplay(convertWeight(currentBw, currentBwUnit, preferredUnit)))
                  : '',
              );
            }}
            role="button"
            aria-label="Record new body weight"
          >
            <span style={{ fontWeight: 600 }}>
              {currentBw !== null ? formatWeight(currentBw, currentBwUnit, preferredUnit) : 'No weight recorded'}
            </span>
            <span style={{ fontSize: '0.8rem', color: '#7f8c8d' }}>✎ Record new weight</span>
          </div>
        )}
      </section>

      {/* Per-lift goal cards */}
      <section>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Lift Goals</h2>
        {trainingMaxes.map((m) => {
          const row = rows[m.lift];
          const hasGoal = goalFor(m.lift) !== undefined;
          const name = nameOf(m.lift);
          const bwInRowUnit = currentBw !== null ? convertWeight(currentBw, currentBwUnit, row.unit) : null;
          const progress = currentBw
            ? computeProgress({
                tmWeight: m.weight,
                tmUnit: m.unit,
                bw: currentBw,
                bwUnit: currentBwUnit,
                goalType: row.goalType,
                target: row.target,
                targetUnit: row.unit,
                ratio: row.ratio,
              })
            : null;

          const computedTarget =
            row.goalType === 'relative' && bwInRowUnit && parseFloat(row.ratio) > 0
              ? Math.round(bwInRowUnit * parseFloat(row.ratio))
              : null;

          const bwPercent =
            row.goalType === 'absolute' && bwInRowUnit && parseFloat(row.target) > 0
              ? Math.round((parseFloat(row.target) / bwInRowUnit) * 100)
              : null;

          return (
            <div
              key={m.lift}
              style={{
                border: '1px solid #ddd',
                borderRadius: 6,
                padding: '0.75rem',
                marginBottom: '0.75rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
                <strong>{name}</strong>
                <span style={{ fontSize: '0.85rem', color: '#666' }}>
                  Current max: {formatWeight(m.weight, m.unit, preferredUnit)}
                </span>
              </div>

              {/* Goal type toggle */}
              <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem' }}>
                {(['relative', 'absolute'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => updateRow(m.lift, { goalType: type })}
                    style={{
                      padding: '2px 10px',
                      fontSize: '0.75rem',
                      borderRadius: 4,
                      border: '1px solid #ccc',
                      background: row.goalType === type ? '#3b82f6' : '#f5f5f5',
                      color: row.goalType === type ? '#fff' : '#333',
                      cursor: 'pointer',
                    }}
                  >
                    {type === 'relative' ? 'Relative (× BW)' : 'Absolute (lbs/kg)'}
                  </button>
                ))}
              </div>

              {/* Input fields */}
              {row.goalType === 'relative' ? (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    placeholder="BW ratio (e.g. 1.75)"
                    value={row.ratio}
                    onChange={(e) => updateRow(m.lift, { ratio: e.target.value })}
                    style={{ width: 140 }}
                    aria-label={`Body weight ratio for ${name}`}
                  />
                  <span style={{ fontSize: '0.85rem', color: '#555' }}>× BW</span>
                  {computedTarget !== null && (
                    <span
                      style={{ fontSize: '0.8rem', color: '#666' }}
                      title={`${row.ratio}× BW = ${computedTarget} ${row.unit} at current weight`}
                    >
                      = {computedTarget} {row.unit}
                    </span>
                  )}
                  <select
                    value={row.unit}
                    onChange={(e) => updateRow(m.lift, { unit: e.target.value as 'lbs' | 'kg' })}
                    aria-label={`Unit for ${name}`}
                  >
                    <option value="lbs">lbs</option>
                    <option value="kg">kg</option>
                  </select>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    placeholder="Target weight"
                    value={row.target}
                    onChange={(e) => updateRow(m.lift, { target: e.target.value })}
                    style={{ width: 110 }}
                    aria-label={`Target weight for ${name}`}
                  />
                  <select
                    value={row.unit}
                    onChange={(e) => updateRow(m.lift, { unit: e.target.value as 'lbs' | 'kg' })}
                    aria-label={`Unit for ${name}`}
                  >
                    <option value="lbs">lbs</option>
                    <option value="kg">kg</option>
                  </select>
                  {bwPercent !== null && (
                    <span style={{ fontSize: '0.8rem', color: '#666' }}>
                      = {bwPercent}% of body weight
                    </span>
                  )}
                </div>
              )}

              {/* Progress bar */}
              {progress !== null && hasGoal && (
                <div style={{ margin: '0.5rem 0' }}>
                  <div
                    title={
                      row.goalType === 'relative'
                        ? `Goal: ${row.ratio}× BW`
                        : `Goal: ${row.target} ${row.unit}`
                    }
                    style={{
                      height: 8,
                      background: '#eee',
                      borderRadius: 4,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.min(progress * 100, 100)}%`,
                        background: progress >= 1 ? '#22c55e' : '#3b82f6',
                        transition: 'width 0.3s',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: '0.75rem', color: '#666' }}>
                    {Math.round(progress * 100)}% of goal
                    {row.goalType === 'relative' && row.ratio
                      ? ` (${row.ratio}× BW)`
                      : ''}
                  </span>
                </div>
              )}

              {/* Save / delete */}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button type="button" onClick={() => handleSave(m.lift)} disabled={row.saving}>
                  {row.saving ? '…' : '✓ Save'}
                </button>
                {hasGoal && (
                  <button type="button" onClick={() => handleDelete(m.lift)} disabled={row.saving}>
                    ✕ Remove
                  </button>
                )}
              </div>
              {row.error && <p style={{ color: 'red', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>{row.error}</p>}
            </div>
          );
        })}
      </section>

      {uncarded.length > 0 && (
        <section style={{ marginTop: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Other Goals</h2>
          <p style={{ fontSize: '0.85rem', color: '#666', margin: '0 0 0.5rem' }}>
            These goals have no card above, so their progress isn&apos;t shown. Either the lift has no
            training max yet, or its card shows a goal stored under another spelling of the lift.
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {uncarded.map((g) => {
              const name = nameOf(g.lift);
              const state = listed[g.lift];
              return (
                <li
                  key={g.lift}
                  style={{
                    border: '1px solid #ddd',
                    borderRadius: 6,
                    padding: '0.5rem 0.75rem',
                    marginBottom: '0.5rem',
                  }}
                >
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline' }}>
                    <strong>{name}</strong>
                    <span style={{ fontSize: '0.85rem', color: '#666' }}>Goal: {targetText(g, preferredUnit)}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveListed(g.lift)}
                      disabled={state?.removing}
                      aria-label={`Remove goal for ${name}`}
                      style={{ marginLeft: 'auto' }}
                    >
                      {state?.removing ? '…' : '✕ Remove'}
                    </button>
                  </div>
                  {state?.error && <p style={{ color: 'red', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>{state.error}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
