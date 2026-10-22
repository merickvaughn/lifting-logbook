import type { CustomProgramSpecRow } from '@lifting-logbook/types';
import {
  daysFromSpecs,
  defaultWeeks,
  specsFromDays,
  uid,
  type LiftInstance,
  type WeekParams,
  type WorkoutDayModel,
} from './programSpecMapping';

function makeInstance(lift: string): LiftInstance {
  return { id: uid(), lift, weeks: defaultWeeks(5) };
}

function makeDay(...lifts: string[]): WorkoutDayModel {
  return { id: uid(), instances: lifts.map(makeInstance) };
}

const naturalKey = (s: CustomProgramSpecRow) => `${s.week}:${s.offset}:${s.lift}:${s.order}`;

function legacyRow(week: number, lift: string, order: number, offset = 0): CustomProgramSpecRow {
  return {
    week,
    offset,
    lift,
    order,
    increment: 5,
    sets: 3,
    reps: 5,
    amrap: false,
    warmUpPct: '0.4,0.5,0.6',
    wtDecrementPct: 0.1,
    activation: 'compound',
  };
}

describe('specsFromDays', () => {
  it('emits one row per (week × instance) with contiguous offsets and 1-based order', () => {
    const specs = specsFromDays([makeDay('Squat', 'Bench Press'), makeDay('Overhead Press')]);
    // (2 + 1) instances × 3 weeks
    expect(specs).toHaveLength(9);
    expect([...new Set(specs.map((s) => s.offset))].sort()).toEqual([0, 1]);
    expect([...new Set(specs.map((s) => s.week))].sort()).toEqual([1, 2, 3]);
    // Day 1 orders are 1,2; Day 2 order is 1.
    const day0Week1 = specs.filter((s) => s.offset === 0 && s.week === 1);
    expect(day0Week1.map((s) => s.order)).toEqual([1, 2]);
  });

  it('places the same lift on two days as distinct offsets with no duplicate natural key', () => {
    // Squat on Day 1 and Day 3 — the motivating requirement (issue #751).
    const specs = specsFromDays([
      makeDay('Squat', 'Bench Press'),
      makeDay('Overhead Press'),
      makeDay('Squat', 'Deadlift'),
    ]);
    const squat = specs.filter((s) => s.lift === 'Squat');
    expect(squat).toHaveLength(6); // 2 instances × 3 weeks
    expect([...new Set(squat.map((s) => s.offset))].sort()).toEqual([0, 2]);
    const keys = specs.map(naturalKey);
    expect(new Set(keys).size).toBe(keys.length); // no P2002 collision by construction
  });

  it('distinguishes the same lift twice within one day by order', () => {
    const specs = specsFromDays([makeDay('Squat', 'Squat')]);
    const week1 = specs.filter((s) => s.week === 1);
    expect(week1.map((s) => s.order)).toEqual([1, 2]);
    expect(week1.every((s) => s.offset === 0)).toBe(true);
  });

  it('drops empty days and keeps the remaining offsets contiguous', () => {
    const specs = specsFromDays([makeDay('Squat'), makeDay(), makeDay('Bench Press')]);
    expect([...new Set(specs.map((s) => s.offset))].sort()).toEqual([0, 1]);
    expect(specs.filter((s) => s.lift === 'Bench Press').every((s) => s.offset === 1)).toBe(true);
  });

  it('emits nothing when every day is empty', () => {
    expect(specsFromDays([makeDay(), makeDay()])).toEqual([]);
    expect(specsFromDays([])).toEqual([]);
  });

  it('preserves per-week loading params', () => {
    const week = (reps: number, amrap: boolean): WeekParams => ({
      sets: 5,
      reps,
      amrap,
      increment: 5,
      warmUpPct: '0.4',
      wtDecrementPct: 0.1,
      activation: 'compound',
    });
    const day: WorkoutDayModel = {
      id: uid(),
      instances: [{ id: uid(), lift: 'Squat', weeks: { 1: week(5, false), 2: week(3, false), 3: week(1, true) } }],
    };
    const specs = specsFromDays([day]);
    expect(specs.find((s) => s.week === 1)?.reps).toBe(5);
    expect(specs.find((s) => s.week === 2)?.reps).toBe(3);
    expect(specs.find((s) => s.week === 3)?.reps).toBe(1);
    expect(specs.find((s) => s.week === 3)?.amrap).toBe(true);
  });

  it('never emits a client-only id field', () => {
    const specs = specsFromDays([makeDay('Squat')]);
    for (const row of specs) {
      expect(Object.prototype.hasOwnProperty.call(row, 'id')).toBe(false);
    }
  });
});

describe('daysFromSpecs', () => {
  it('round-trips the day/instance structure through specsFromDays', () => {
    const days = [makeDay('Squat', 'Bench Press'), makeDay('Overhead Press'), makeDay('Squat', 'Deadlift')];
    const roundTrip = daysFromSpecs(specsFromDays(days));
    expect(roundTrip.map((d) => d.instances.map((i) => i.lift))).toEqual([
      ['Squat', 'Bench Press'],
      ['Overhead Press'],
      ['Squat', 'Deadlift'],
    ]);
  });

  it('collapses a legacy all-offset-0 program to a single populated day', () => {
    const legacy: CustomProgramSpecRow[] = [1, 2, 3].flatMap((week) => [
      legacyRow(week, 'Squat', 1),
      legacyRow(week, 'Bench Press', 2),
    ]);
    const days = daysFromSpecs(legacy);
    expect(days).toHaveLength(1);
    expect(days[0]?.instances.map((i) => i.lift)).toEqual(['Squat', 'Bench Press']);
  });

  it('reconstructs a multi-day preset (spaced offsets 0/2/4) as separate days', () => {
    const specs: CustomProgramSpecRow[] = [];
    const layout: [number, string[]][] = [
      [0, ['Bench Press', 'Weighted Pull-ups']],
      [2, ['Squat']],
      [4, ['Overhead Press']],
    ];
    for (const [offset, lifts] of layout) {
      for (const week of [1, 2, 3]) {
        lifts.forEach((lift, i) => specs.push(legacyRow(week, lift, i + 1, offset)));
      }
    }
    const days = daysFromSpecs(specs);
    expect(days).toHaveLength(3);
    expect(days.map((d) => d.instances.length)).toEqual([2, 1, 1]);
    // Re-saving renormalizes the spaced offsets to contiguous 0/1/2.
    expect([...new Set(specsFromDays(days).map((s) => s.offset))].sort()).toEqual([0, 1, 2]);
  });

  it('falls back to the week-1 row for weeks with no stored row', () => {
    const days = daysFromSpecs([
      { ...legacyRow(1, 'Squat', 1), sets: 4, reps: 6 },
    ]);
    const inst = days[0]?.instances[0];
    expect(inst?.weeks[1].sets).toBe(4);
    expect(inst?.weeks[2].sets).toBe(4); // fell back to week 1
    expect(inst?.weeks[3].reps).toBe(6);
  });

  it('keeps both lifts when two different lifts share the same (offset, order)', () => {
    // Not producible by the editor or presets (they assign each lift a distinct
    // order), but reachable via the custom-program spec-import path — the natural
    // key includes `lift`, so the store permits it. Grouping by `order` alone would
    // silently drop one lift on edit-load, then delete it permanently on re-save.
    const specs: CustomProgramSpecRow[] = [1, 2, 3].flatMap((week) => [
      legacyRow(week, 'Squat', 1, 0),
      legacyRow(week, 'Bench Press', 1, 0),
    ]);
    const days = daysFromSpecs(specs);
    expect(days).toHaveLength(1);
    const lifts = days[0]?.instances.map((i) => i.lift) ?? [];
    expect(lifts).toHaveLength(2);
    expect([...lifts].sort()).toEqual(['Bench Press', 'Squat']);
    // Re-saving renumbers order so the two instances no longer collide.
    const resaved = specsFromDays(days);
    const week1Day0 = resaved.filter((s) => s.week === 1 && s.offset === 0);
    expect(week1Day0.map((s) => s.order).sort()).toEqual([1, 2]);
    const keys = resaved.map(naturalKey);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate natural key
  });
});
