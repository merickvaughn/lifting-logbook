import type { FocusBlock, FocusPoolEntry } from '@lifting-logbook/types';
import { buildMuscleTargetResolver } from '@src/core';

// Local lift fixtures, declared as user overrides so the focus tests never depend on the
// built-in catalog's muscle data. Secondary muscles are listed to prove they don't count.
export const resolveMuscles = buildMuscleTargetResolver([
  { lift: 'Fixture Squat', muscleGroups: ['Quads', 'Glutes'] },
  { lift: 'Fixture Overhead Press', muscleGroups: ['Front Delts'], secondaryMuscleGroups: ['Triceps'] },
  { lift: 'Fixture Arnold Press', muscleGroups: ['Front Delts', 'Side Delts'] },
  { lift: 'Fixture Bench', muscleGroups: ['Chest'], secondaryMuscleGroups: ['Triceps', 'Front Delts'] },
  { lift: 'Fixture Dips', muscleGroups: ['Chest', 'Triceps'] },
  { lift: 'Fixture Chin-up', muscleGroups: ['Lats'], secondaryMuscleGroups: ['Biceps'] },
]);

export function entry(lift: string, overrides: Partial<FocusPoolEntry> = {}): FocusPoolEntry {
  return {
    lift,
    include: 'auto',
    ruleLift: '',
    swapTo: '',
    sets: 3,
    repsLow: 10,
    repsHigh: 12,
    weight: 25,
    trainingMax: 40,
    percent: 65,
    rpe: 8,
    ...overrides,
  };
}

/** A Q4 2026 shoulder block by default. */
export function block(overrides: Partial<FocusBlock> = {}): FocusBlock {
  return {
    id: 'sh',
    series: 's1',
    area: 'Shoulders',
    period: 'quarterly',
    align: 'calendar',
    start: '2026-10-01',
    selection: 'rules',
    overlap: 'anyway',
    progression: 'double',
    priority: 1,
    timer: { prep: 10, set: 45, rest: 60 },
    onEnd: 'prompt',
    nextArea: null,
    pool: [entry('Lateral Raise'), entry('Upright Row'), entry('Face Pull')],
    ...overrides,
  };
}
