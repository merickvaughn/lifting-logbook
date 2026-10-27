import { STANDARD_DURATIONS } from '@lifting-logbook/core';
import type { FocusPlacement, FocusPlanGroupResponse } from '@lifting-logbook/types';
import { planGroup, planItem } from './focusPlanFixture';
import {
  describePrescription,
  focusRowIds,
  formatClock,
  interleavedOrder,
  moveRow,
  overlapNote,
  plannedRowIds,
  plannedSeconds,
  prescribedSet,
  skipReason,
  timerHint,
  workoutOrder,
} from '../focusWorkout';

describe('describePrescription', () => {
  it('words a double-progression range, with the last session when there is one', () => {
    expect(
      describePrescription(
        { progression: 'double', sets: 3, repsLow: 10, repsHigh: 12, weight: 25, lastReps: [12, 11, 10] },
        'lbs',
      ),
    ).toEqual({
      summary: '3 × 10–12',
      perSet: '10–12 reps @ 25 lbs',
      hint: 'Last time: 12, 11, 10. Hit 12 on every set and the weight goes up next time.',
    });
  });

  it('collapses a one-number range and drops the last-time note without history', () => {
    const text = describePrescription(
      { progression: 'double', sets: 2, repsLow: 15, repsHigh: 15, weight: 20, lastReps: null },
      'lbs',
    );
    expect(text.summary).toBe('2 × 15');
    expect(text.hint).toBe('Hit 15 on every set and the weight goes up next time.');
  });

  it('words fixed, percent-of-training-max and RPE prescriptions', () => {
    expect(describePrescription({ progression: 'fixed', sets: 3, reps: 12, weight: 30 }, 'lbs').summary).toBe('3 × 12');
    expect(
      describePrescription({ progression: 'tm', sets: 3, reps: 10, weight: 25, percent: 65, trainingMax: 40 }, 'lbs'),
    ).toEqual({ summary: '3 × 10 @ 65%', perSet: '10 reps @ 25 lbs', hint: '65% of a 40 lbs training max.' });
    expect(describePrescription({ progression: 'rpe', sets: 3, reps: 12, rpe: 9, repsInReserve: 1 }, 'lbs')).toEqual({
      summary: '3 × 12 @ RPE 9',
      perSet: '12 reps @ RPE 9',
      hint: 'Pick a weight that leaves about 1 rep in reserve.',
    });
    expect(describePrescription({ progression: 'rpe', sets: 3, reps: 12, rpe: 8, repsInReserve: 2 }, 'lbs').hint).toBe(
      'Pick a weight that leaves about 2 reps in reserve.',
    );
  });

  it('shows weights in the lifter’s unit', () => {
    expect(describePrescription({ progression: 'fixed', sets: 1, reps: 10, weight: 22.05, }, 'kg').perSet).toBe('10 reps @ 10 kg');
  });
});

describe('timer copy', () => {
  it('formats m:ss and the focus block’s timer', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(90)).toBe('1:30');
    expect(timerHint({ prep: 10, set: 45, rest: 60 })).toBe('Timer: 0:10 setup · 0:45 set · 1:00 rest.');
  });
});

describe('plannedSeconds', () => {
  it('counts prep, the set and its rest on the Standard preset', () => {
    const d = STANDARD_DURATIONS;
    expect(plannedSeconds([{ type: 'warmup' }, { type: 'work' }])).toBe(
      d.prep + d.warmupSet + d.restWarmup + d.prep + d.workSet + d.restWork,
    );
    expect(plannedSeconds([])).toBe(0);
  });
});

function group(overrides: Partial<FocusPlanGroupResponse> = {}): FocusPlanGroupResponse {
  return planGroup({ overlap: { lifts: ['Overhead Press', 'Dips'], mode: 'reduce' }, ...overrides });
}

describe('skipReason and overlapNote', () => {
  it('words each skip reason', () => {
    expect(skipReason({ lift: 'A', reason: 'rule', detail: 'Overhead Press' }, 'Shoulders')).toBe(
      'your rule: Overhead Press is planned',
    );
    expect(skipReason({ lift: 'A', reason: 'rotation', detail: '' }, 'Shoulders')).toBe('rotation, up on another day');
    expect(skipReason({ lift: 'A', reason: 'fixed', detail: 'Lateral Raise' }, 'Shoulders')).toBe(
      'fixed mode uses Lateral Raise',
    );
    expect(skipReason({ lift: 'A', reason: 'overlap', detail: 'Overhead Press' }, 'Shoulders')).toBe(
      'Overhead Press already trains shoulders',
    );
  });

  it('notes a reduced or swapped lift, and nothing for one run as planned', () => {
    const item = planItem('Lateral Raise', 2);
    expect(overlapNote({ ...item, reducedFrom: 3 }, group())).toBe(
      'Reduced 3 → 2 sets: Overhead Press & Dips trains shoulders today',
    );
    expect(overlapNote({ ...item, swappedFrom: 'Arnold Press' }, group())).toBe(
      'Swapped from Arnold Press: Overhead Press & Dips trains shoulders today',
    );
    expect(overlapNote(item, group())).toBeNull();
    expect(overlapNote({ ...item, reducedFrom: 3 }, group({ overlap: null }))).toBeNull();
  });
});

describe('row ids and order', () => {
  it('gives a lift listed twice two ids, and the same lift the same id on every call', () => {
    const [squat, bench, squatAgain] = plannedRowIds(['Squat', 'Bench Press', 'Squat']);
    expect(squat).toMatch(/^p:[0-9a-f]{8}#0$/);
    expect(squatAgain).toBe(squat?.replace(/#0$/, '#1'));
    expect(bench).not.toBe(squat);
    expect(plannedRowIds(['Squat'])).toEqual([squat]);

    const [first, second] = focusRowIds('b1', ['Lateral Raise', 'Lateral Raise']);
    expect(first).toMatch(/^f:b1:[0-9a-f]{8}#0$/);
    expect(second).toMatch(/#1$/);
  });

  it('keeps ids inside the API’s 100-character limit for the longest names', () => {
    const longName = 'x'.repeat(100);
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    for (const id of [...plannedRowIds([longName]), ...focusRowIds(uuid, [longName])]) {
      expect(id.length).toBeLessThanOrEqual(100);
    }
  });

  it('puts a focus lift after each planned lift by default', () => {
    expect(interleavedOrder(['p1', 'p2'], ['f1', 'f2', 'f3'], null)).toEqual(['p1', 'f1', 'p2', 'f2', 'f3']);
    expect(interleavedOrder(['p1', 'p2', 'p3'], ['f1'], null)).toEqual(['p1', 'f1', 'p2', 'p3']);
  });

  it('follows a saved order, dropping ids that are gone and appending new ones', () => {
    expect(interleavedOrder(['p1', 'p2'], ['f1', 'f2'], ['f2', 'gone', 'p2', 'p1', 'p2'])).toEqual([
      'f2',
      'p2',
      'p1',
      'f1',
    ]);
  });

  it('moves one row and ignores moves off the ends', () => {
    expect(moveRow(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveRow(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveRow(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveRow(['a', 'b'], 1, 2)).toEqual(['a', 'b']);
  });
});

describe('workoutOrder (#1060)', () => {
  const groups = [planGroup({ items: [planItem('Lateral Raise'), planItem('Face Pull')] })];
  const describeOrder = (placement: FocusPlacement, order: string[] | null = null) =>
    workoutOrder(['Squat', 'Bench Press'], groups, { placement, order }).map((entry) =>
      entry.kind === 'planned' ? `p${entry.liftIndex}` : entry.item.lift,
    );

  it('puts focus work before, after or among the planned lifts', () => {
    expect(describeOrder('before')).toEqual(['Lateral Raise', 'Face Pull', 'p0', 'p1']);
    expect(describeOrder('after')).toEqual(['p0', 'p1', 'Lateral Raise', 'Face Pull']);
    expect(describeOrder('interleave')).toEqual(['p0', 'Lateral Raise', 'p1', 'Face Pull']);
  });

  it('follows a saved interleaved order by the rows’ own ids', () => {
    const [squat, bench] = plannedRowIds(['Squat', 'Bench Press']);
    const [raise, pull] = focusRowIds('b-shoulders', ['Lateral Raise', 'Face Pull']);
    expect(describeOrder('interleave', [bench ?? '', pull ?? '', squat ?? '', raise ?? ''])).toEqual([
      'p1',
      'Face Pull',
      'p0',
      'Lateral Raise',
    ]);
    // A saved order only applies when interleaved.
    expect(describeOrder('after', [bench ?? '', pull ?? ''])).toEqual(['p0', 'p1', 'Lateral Raise', 'Face Pull']);
  });

  it('carries the row ids the details page renders', () => {
    const ids = workoutOrder(['Squat'], groups, { placement: 'after', order: null }).map((entry) => entry.id);
    expect(ids).toEqual([...plannedRowIds(['Squat']), ...focusRowIds('b-shoulders', ['Lateral Raise', 'Face Pull'])]);
  });
});

describe('prescribedSet', () => {
  it('starts each set from the prescription’s target', () => {
    expect(
      prescribedSet({ progression: 'double', sets: 3, repsLow: 10, repsHigh: 12, weight: 25, lastReps: null }),
    ).toEqual({ weight: 25, reps: 12 });
    expect(prescribedSet({ progression: 'fixed', sets: 3, reps: 12, weight: 30 })).toEqual({ weight: 30, reps: 12 });
    expect(
      prescribedSet({ progression: 'tm', sets: 3, reps: 10, weight: 25, percent: 65, trainingMax: 40 }),
    ).toEqual({ weight: 25, reps: 10 });
    expect(prescribedSet({ progression: 'rpe', sets: 3, reps: 12, rpe: 9, repsInReserve: 1 })).toEqual({
      weight: 0,
      reps: 12,
    });
  });
});
