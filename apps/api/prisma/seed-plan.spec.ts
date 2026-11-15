import { Prisma } from '@prisma/client';
import {
  PRESET_BASE_SPECS,
  currentMaxLookup,
  noScheduleWorkoutDateUTC,
  programWorkoutKeys,
  specRowsForWorkoutDay,
} from '@lifting-logbook/core';
import { PROGRAM_DEFAULTS } from '../src/programs/macrocycle-generation.service';
import { PROGRAM, SEED_USER_ID, buildSeedPlan, resetSeedUser } from './seed-plan';

// The staging seed user must be a user the app can plan for (#1022): an earlier seed wrote
// program '531' and lift names like 'squat', which nothing resolves.
describe('buildSeedPlan', () => {
  const now = new Date('2026-11-15T15:30:00.000Z');
  const today = new Date('2026-11-15T00:00:00.000Z');
  const plan = buildSeedPlan(now);
  const spec = PRESET_BASE_SPECS[PROGRAM] ?? [];
  const keys = programWorkoutKeys(PROGRAM, spec);
  const specLifts = [...new Set(spec.map((row) => row.lift))];

  it('runs a built-in program the spec and macrocycle defaults both know', () => {
    expect(spec.length).toBeGreaterThan(0);
    expect(plan.userSettings.activeProgram).toBe(PROGRAM);
    expect(plan.dashboard).toMatchObject({ program: PROGRAM, ...PROGRAM_DEFAULTS[PROGRAM] });
  });

  it('gives every lift the program plans a training max under its spec name', () => {
    expect(plan.trainingMaxes.map((max) => max.lift).sort()).toEqual([...specLifts].sort());
    const maxFor = currentMaxLookup(
      plan.trainingMaxes.map((max) => ({ lift: max.lift, dateUpdated: max.dateUpdated, weight: max.weight })),
    );
    for (const lift of specLifts) expect(maxFor(lift)?.weight).toBeGreaterThan(0);
  });

  it('names only spec lifts in history and goals', () => {
    const named = new Set([
      ...plan.liftRecords.map((record) => record.lift),
      ...plan.trainingMaxHistory.map((entry) => entry.lift),
      ...plan.strengthGoals.map((goal) => goal.lift),
    ]);
    expect([...named].sort()).toEqual([...specLifts].sort());
  });

  it('logs each set on the workout and date the program plans it', () => {
    const starts = new Map(plan.macrocycles.map((m) => [m.macrocycleNum, new Date(m.startDate)]));
    for (const record of plan.liftRecords) {
      const key = keys[record.workoutNum - 1];
      const start = starts.get(record.macrocycleNum);
      if (!key || !start) throw new Error(`No workout ${record.workoutNum} in macrocycle ${record.macrocycleNum}`);
      expect(specRowsForWorkoutDay(spec, key.week, key.offset).map((row) => row.lift)).toContain(record.lift);
      expect(record.date).toEqual(noScheduleWorkoutDateUTC(start, key.week, key.offset));
      expect(new Date(record.date).getTime()).toBeLessThan(today.getTime());
    }
  });

  it('writes no two sets with the same natural key', () => {
    const naturalKeys = plan.liftRecords.map((r) =>
      [r.macrocycleNum, r.workoutNum, new Date(r.date).toISOString(), r.lift, r.occurrence, r.setNum].join('|'),
    );
    expect(new Set(naturalKeys).size).toBe(naturalKeys.length);
  });

  it('leaves the current macrocycle part logged with workouts still to come', () => {
    const current = plan.macrocycles.find((m) => m.status === 'in-progress');
    expect(current?.macrocycleNum).toBe(plan.dashboard.macrocycleNum);
    expect(current?.startDate).toEqual(plan.dashboard.macrocycleDate);
    const logged = new Set(
      plan.liftRecords.filter((r) => r.macrocycleNum === current?.macrocycleNum).map((r) => r.workoutNum),
    );
    expect(logged.size).toBeGreaterThan(0);
    expect(logged.size).toBeLessThan(keys.length);
  });

  it('keeps one macrocycle row per macrocycle, each closed before the next starts', () => {
    const nums = plan.macrocycles.map((m) => m.macrocycleNum);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    expect(new Set(plan.liftRecords.map((r) => r.macrocycleNum))).toEqual(new Set(nums));
    plan.macrocycles.slice(0, -1).forEach((m, i) => {
      const next = plan.macrocycles[i + 1];
      if (!m.endDate || !next) throw new Error(`Macrocycle ${m.macrocycleNum} has no end date or successor`);
      expect(m.status).toBe('completed');
      expect(new Date(m.endDate).getTime()).toBeLessThan(new Date(next.startDate).getTime());
    });
  });

  it('sets no workout schedule, so workouts are dated from the spec', () => {
    expect(plan.userSettings.workoutSchedule).toBeUndefined();
  });

  it('scopes every row to the seed user', () => {
    const rows = [
      plan.userSettings,
      plan.dashboard,
      ...plan.macrocycles,
      ...plan.trainingMaxes,
      ...plan.trainingMaxHistory,
      ...plan.liftRecords,
      ...plan.strengthGoals,
    ];
    for (const row of rows) expect(row.userId).toBe(SEED_USER_ID);
  });
});

describe('resetSeedUser', () => {
  it("deletes the seed user's rows from every table with a userId, LiftMetadata included", async () => {
    const deleted = new Map<string, unknown>();
    const tx = new Proxy(
      {},
      {
        get: (_target, delegate: string) => ({
          deleteMany: async (args: unknown) => {
            deleted.set(delegate, args);
          },
        }),
      },
    ) as Prisma.TransactionClient;

    await resetSeedUser(tx);

    const userTables = Prisma.dmmf.datamodel.models
      .filter((model) => model.fields.some((field) => field.name === 'userId'))
      .map((model) => model.name.charAt(0).toLowerCase() + model.name.slice(1));
    expect(userTables).toContain('liftMetadata');
    expect([...deleted.keys()].sort()).toEqual(userTables.sort());
    for (const args of deleted.values()) expect(args).toEqual({ where: { userId: SEED_USER_ID } });
  });
});
