'use client';

import { useState } from 'react';
import type { RedateMacrocycleResponse, UserWorkoutSchedule } from '@lifting-logbook/types';
import { logClientError } from '@/lib/log-client-error';
import { redateMacrocycle, saveSchedule } from './actions';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

type Mode = 'none' | 'fixed' | 'rotating';

function initialState(schedule: UserWorkoutSchedule | null): {
  mode: Mode;
  fixedDays: number[];
  rotatingWeeks: number[][];
} {
  if (!schedule) return { mode: 'none', fixedDays: [], rotatingWeeks: [[]] };
  if (schedule.type === 'fixed') {
    return {
      mode: 'fixed',
      fixedDays: schedule.days ?? [],
      rotatingWeeks: [[]],
    };
  }
  return {
    mode: 'rotating',
    fixedDays: [],
    rotatingWeeks: schedule.weeks?.length ? schedule.weeks : [[]],
  };
}

function toggleDay(days: number[], day: number): number[] {
  return days.includes(day)
    ? days.filter((d) => d !== day).sort((a, b) => a - b)
    : [...days, day].sort((a, b) => a - b);
}

// The lifter's own calendar date, which the re-dated workouts start on or after. The server's
// UTC date is a day ahead in a US evening.
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** What re-dating the current macrocycle did (#1032), in the lifter's words. */
export function redateMessage(result: RedateMacrocycleResponse | null): string {
  if (result === null) return 'You have no current macrocycle, so there was nothing to re-date.';
  if (!result.scheduled) {
    if (result.kept === 0) return 'Your current macrocycle is no longer scheduled.';
    return (
      `The workouts left in your current macrocycle are no longer scheduled. The ${result.kept} ` +
      `you've logged or skipped keep their scheduled dates, so the macrocycle still lists them by ` +
      `those dates.`
    );
  }
  if (result.redated === 0 || result.firstDate === null) {
    return 'Every workout in your current macrocycle is logged, skipped or rescheduled, so none were re-dated.';
  }
  const workouts = result.redated === 1 ? '1 workout' : `${result.redated} workouts`;
  return `Re-dated ${workouts} in your current macrocycle, starting ${formatDay(result.firstDate)}.`;
}

export default function ScheduleForm({
  initialSchedule,
  activeProgram = null,
}: {
  initialSchedule: UserWorkoutSchedule | null;
  /** The program whose current macrocycle saving can re-date; null offers no re-dating. */
  activeProgram?: string | null;
}) {
  const init = initialState(initialSchedule);
  const [mode, setMode] = useState<Mode>(init.mode);
  const [fixedDays, setFixedDays] = useState<number[]>(init.fixedDays);
  const [rotatingWeeks, setRotatingWeeks] = useState<number[][]>(init.rotatingWeeks);
  const [redate, setRedate] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [redateNote, setRedateNote] = useState<string | null>(null);

  // Switching modes resets the other mode's draft state so buildPayload never silently
  // carries selections the user no longer sees. Without this, fixed → rotating → fixed
  // would restore previously-picked days, which surprises users (and risks a future
  // auto-save sending stale data).
  function switchMode(next: Mode) {
    setMode(next);
    if (next !== 'fixed') setFixedDays([]);
    if (next !== 'rotating') setRotatingWeeks([[]]);
    setError(null);
    setSavedAt(null);
    setRedateNote(null);
  }

  function buildPayload(): UserWorkoutSchedule | null {
    if (mode === 'none') return null;
    if (mode === 'fixed') return { type: 'fixed', days: fixedDays };
    return { type: 'rotating', weeks: rotatingWeeks };
  }

  function validate(payload: UserWorkoutSchedule | null): string | null {
    if (payload === null) return null;
    if (payload.type === 'fixed') {
      if (!payload.days || payload.days.length === 0) {
        return 'Pick at least one day.';
      }
    } else {
      if (!payload.weeks || payload.weeks.some((w) => w.length === 0)) {
        return 'Each week must have at least one day.';
      }
    }
    return null;
  }

  async function handleSave() {
    setError(null);
    setSavedAt(null);
    setRedateNote(null);
    const payload = buildPayload();
    const validationError = validate(payload);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    try {
      // Re-seed local state from the canonical server response. `useState` initializers
      // only run on mount, so without this the form would keep showing optimistic local
      // state if the server normalized the payload (e.g., re-sorted days, dropped dupes)
      // or if a future code path returns a stored value different from what we sent.
      const result = await saveSchedule({ workoutSchedule: payload });
      const next = initialState(result.workoutSchedule);
      setMode(next.mode);
      setFixedDays(next.fixedDays);
      setRotatingWeeks(next.rotatingWeeks);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save schedule.');
      setSaving(false);
      return;
    }
    // A schedule otherwise dates a macrocycle only when it starts (#1032).
    if (activeProgram && redate) {
      try {
        setRedateNote(redateMessage(await redateMacrocycle(activeProgram, localToday())));
      } catch (err) {
        logClientError('redateMacrocycle', err, { program: activeProgram });
        setError(
          'Your schedule is saved, but re-dating your current macrocycle failed. Save again to retry.',
        );
      }
    }
    setSaving(false);
  }

  return (
    <section>
      <h2>Workout Schedule</h2>
      <p>
        Choose which days of the week you usually train. Lifting Logbook uses this to
        distribute upcoming workouts across the calendar.
      </p>

      <fieldset>
        <legend>Mode</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'none'}
            onChange={() => switchMode('none')}
          />
          No schedule (date is set when you log)
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'fixed'}
            onChange={() => switchMode('fixed')}
          />
          Fixed days
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'rotating'}
            onChange={() => switchMode('rotating')}
          />
          Rotating weeks
        </label>
      </fieldset>

      {mode === 'fixed' && (
        <fieldset>
          <legend>Training days</legend>
          {DAY_LABELS.map((label, idx) => (
            <label key={idx}>
              <input
                type="checkbox"
                checked={fixedDays.includes(idx)}
                onChange={() => setFixedDays((d) => toggleDay(d, idx))}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}

      {mode === 'rotating' && (
        <div>
          {rotatingWeeks.map((week, weekIdx) => (
            <fieldset key={weekIdx}>
              <legend>Week {weekIdx + 1}</legend>
              {DAY_LABELS.map((label, dayIdx) => (
                <label key={dayIdx}>
                  <input
                    type="checkbox"
                    checked={week.includes(dayIdx)}
                    onChange={() =>
                      setRotatingWeeks((weeks) =>
                        weeks.map((w, i) => (i === weekIdx ? toggleDay(w, dayIdx) : w)),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
              {rotatingWeeks.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setRotatingWeeks((weeks) => weeks.filter((_, i) => i !== weekIdx))
                  }
                >
                  Remove week
                </button>
              )}
            </fieldset>
          ))}
          {rotatingWeeks.length < 8 && (
            <button type="button" onClick={() => setRotatingWeeks((w) => [...w, []])}>
              Add week
            </button>
          )}
        </div>
      )}

      {activeProgram && (
        <label>
          <input type="checkbox" checked={redate} onChange={(e) => setRedate(e.target.checked)} />
          Also re-date the workouts left in my current macrocycle. Logged, skipped and rescheduled
          workouts keep their dates.
        </label>
      )}

      <div>
        <button type="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save schedule'}
        </button>
        {error && <p role="alert">{error}</p>}
        {savedAt && <p>Saved at {savedAt}.</p>}
        {redateNote && <p role="status">{redateNote}</p>}
      </div>
    </section>
  );
}
