import { PrismaExecutor } from './prisma-tx.util';
import { PrismaUserSettingsRepository } from './user-settings.repository';

const USER_ID = 'user-1';

type Row = {
  userId: string;
  activeProgram: string | null;
  workoutSchedule: unknown;
  defaultWeightIncrement: number | null;
  unit: string | null;
  // Optional so the older fixtures below, seeded without them, read as an unset default.
  defaultProgression?: string | null;
  defaultProgressionIncrement?: number | null;
  defaultProgressionRepsLow?: number | null;
  defaultProgressionRepsHigh?: number | null;
};

function makePrismaMock(): { client: PrismaExecutor; store: Map<string, Row> } {
  const store = new Map<string, Row>();
  const client = {
    userSettings: {
      findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => {
        return store.get(where.userId) ?? null;
      }),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId: string };
          create: Partial<Row> & { userId: string };
          update: Partial<Row>;
        }) => {
          const existing = store.get(where.userId);
          const next: Row = existing
            ? { ...existing, ...update }
            : {
                userId: where.userId,
                activeProgram: create.activeProgram ?? null,
                workoutSchedule: create.workoutSchedule ?? null,
                defaultWeightIncrement: create.defaultWeightIncrement ?? null,
                unit: create.unit ?? null,
                defaultProgression: create.defaultProgression ?? null,
                defaultProgressionIncrement: create.defaultProgressionIncrement ?? null,
                defaultProgressionRepsLow: create.defaultProgressionRepsLow ?? null,
                defaultProgressionRepsHigh: create.defaultProgressionRepsHigh ?? null,
              };
          store.set(where.userId, next);
          return next;
        },
      ),
    },
  } as unknown as PrismaExecutor;
  return { client, store };
}

describe('PrismaUserSettingsRepository', () => {
  let mock: ReturnType<typeof makePrismaMock>;
  let repo: PrismaUserSettingsRepository;

  beforeEach(() => {
    mock = makePrismaMock();
    repo = new PrismaUserSettingsRepository(mock.client, USER_ID);
  });

  it('returns null schedule for a fresh user', async () => {
    const result = await repo.getSettings();
    expect(result).toEqual({
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: null,
      unit: null,
      defaultProgression: null,
    });
  });

  // #1210: the lifter's default progression is written as four columns, together.
  it('persists a default progression, replaces it whole, and clears it', async () => {
    const set = await repo.upsertSettings({ defaultProgression: { type: 'double', increment: 2.5, repsLow: 8, repsHigh: 12 } });
    expect(set.defaultProgression).toEqual({ type: 'double', increment: 2.5, repsLow: 8, repsHigh: 12 });

    const replaced = await repo.upsertSettings({ defaultProgression: { type: 'linear' } });
    expect(replaced.defaultProgression).toEqual({ type: 'linear', increment: null, repsLow: null, repsHigh: null });

    await repo.upsertSettings({ unit: 'kg' });
    expect((await repo.getSettings()).defaultProgression).toEqual(replaced.defaultProgression);

    const cleared = await repo.upsertSettings({ defaultProgression: null });
    expect(cleared.defaultProgression).toBeNull();
    expect(mock.store.get(USER_ID)).toMatchObject({
      defaultProgression: null,
      defaultProgressionIncrement: null,
      defaultProgressionRepsLow: null,
      defaultProgressionRepsHigh: null,
    });
  });

  it('reads an unknown stored progression type as unset', async () => {
    await repo.upsertSettings({ unit: 'kg' });
    const row = mock.store.get(USER_ID);
    // Without the row there is nothing to corrupt, and the test would pass without testing the guard.
    if (!row) throw new Error('the upsert stored no row');
    Object.assign(row, { defaultProgression: 'rpe', defaultProgressionRepsHigh: 8 });
    expect((await repo.getSettings()).defaultProgression).toBeNull();
  });

  it('persists a defaultWeightIncrement and reads it back', async () => {
    const patched = await repo.upsertSettings({ defaultWeightIncrement: 0.625 });
    expect(patched.defaultWeightIncrement).toBe(0.625);

    const fetched = await repo.getSettings();
    expect(fetched.defaultWeightIncrement).toBe(0.625);
  });

  it('clears defaultWeightIncrement when patched with null', async () => {
    mock.store.set(USER_ID, {
      userId: USER_ID,
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: 2.5,
      unit: null,
    });
    const result = await repo.upsertSettings({ defaultWeightIncrement: null });
    expect(result.defaultWeightIncrement).toBeNull();
  });

  it('persists a unit preference and reads it back', async () => {
    const patched = await repo.upsertSettings({ unit: 'kg' });
    expect(patched.unit).toBe('kg');

    const fetched = await repo.getSettings();
    expect(fetched.unit).toBe('kg');
  });

  it('clears the unit preference when patched with null', async () => {
    mock.store.set(USER_ID, {
      userId: USER_ID,
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: null,
      unit: 'kg',
    });
    const result = await repo.upsertSettings({ unit: null });
    expect(result.unit).toBeNull();
  });

  it('persists a fixed schedule and reads it back', async () => {
    const patched = await repo.upsertSettings({
      workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
    });
    expect(patched.workoutSchedule).toEqual({ type: 'fixed', days: [0, 2, 4] });

    const fetched = await repo.getSettings();
    expect(fetched.workoutSchedule).toEqual({ type: 'fixed', days: [0, 2, 4] });
  });

  it('returns null when the DB row holds a malformed schedule', async () => {
    // Simulates a row written by a pre-validator code path or a manual edit. The
    // repository's parseSchedule guard should coerce to null rather than letting
    // malformed JSON reach the client.
    mock.store.set(USER_ID, {
      userId: USER_ID,
      activeProgram: null,
      workoutSchedule: { type: 'fixed', days: [0, 99] },
      defaultWeightIncrement: null,
      unit: null,
    });
    const result = await repo.getSettings();
    expect(result.workoutSchedule).toBeNull();
  });

  it('clears the schedule when patched with null', async () => {
    mock.store.set(USER_ID, {
      userId: USER_ID,
      activeProgram: null,
      workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
      defaultWeightIncrement: null,
      unit: null,
    });
    const result = await repo.upsertSettings({ workoutSchedule: null });
    expect(result.workoutSchedule).toBeNull();
  });

  it('persists a rotating schedule', async () => {
    const patched = await repo.upsertSettings({
      workoutSchedule: {
        type: 'rotating',
        weeks: [
          [0, 2, 4, 5],
          [1, 3, 5],
        ],
      },
    });
    expect(patched.workoutSchedule).toEqual({
      type: 'rotating',
      weeks: [
        [0, 2, 4, 5],
        [1, 3, 5],
      ],
    });
  });

  it('leaves other fields unchanged when a patch omits them', async () => {
    await repo.upsertSettings({ activeProgram: '5-3-1', unit: 'kg' });
    const result = await repo.upsertSettings({ defaultWeightIncrement: 2.5 });
    expect(result).toEqual({
      activeProgram: '5-3-1',
      workoutSchedule: null,
      defaultWeightIncrement: 2.5,
      unit: 'kg',
      defaultProgression: null,
    });
  });
});
