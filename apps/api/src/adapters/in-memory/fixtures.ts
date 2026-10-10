import { MacrocycleDashboard, LiftRecord, TrainingMax, Weekday } from '@lifting-logbook/core';

/**
 * Seed data for the in-memory adapters used in v0.2 to wire the API end-to-end
 * before real persistence (Google Sheets adapters + auth) lands. One program,
 * one macrocycle, enough records to render the "today's workout" UI path.
 *
 * Built-in program *specs* are no longer seeded here: the in-memory spec adapter
 * seeds every entry of PRESET_BASE_SPECS directly (issue #739).
 */

export const SEED_PROGRAM = '5-3-1';

export const seedMacrocycleDashboard = (): MacrocycleDashboard => ({
  program: SEED_PROGRAM,
  macrocycleUnit: 'week',
  macrocycleNum: 1,
  macrocycleDate: new Date('2026-04-20T00:00:00.000Z'),
  sheetName: '',
  macrocycleStartWeekday: Weekday.Monday,
  programType: '5-3-1',
});

export const seedTrainingMaxes = (): TrainingMax[] => [
  { lift: 'Squat', weight: 315, dateUpdated: new Date('2026-04-13T00:00:00.000Z') },
  { lift: 'Bench Press', weight: 225, dateUpdated: new Date('2026-04-13T00:00:00.000Z') },
  { lift: 'Deadlift', weight: 405, dateUpdated: new Date('2026-04-13T00:00:00.000Z') },
  { lift: 'Overhead Press', weight: 145, dateUpdated: new Date('2026-04-13T00:00:00.000Z') },
];

export const seedLiftRecords = (): LiftRecord[] => [
  {
    program: SEED_PROGRAM,
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2026-04-20T00:00:00.000Z'),
    lift: 'Squat',
    setNum: 1,
    weight: 205,
    reps: 5,
    notes: '',
  },
  {
    program: SEED_PROGRAM,
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2026-04-20T00:00:00.000Z'),
    lift: 'Squat',
    setNum: 2,
    weight: 235,
    reps: 5,
    notes: '',
  },
  {
    program: SEED_PROGRAM,
    macrocycleNum: 1,
    workoutNum: 1,
    date: new Date('2026-04-20T00:00:00.000Z'),
    lift: 'Squat',
    setNum: 3,
    weight: 265,
    reps: 5,
    notes: 'AMRAP',
  },
];
