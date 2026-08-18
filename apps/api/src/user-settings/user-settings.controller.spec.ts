import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { UserSettingsController } from './user-settings.controller';
import { UpdateSettingsDto } from './update-settings.dto';

const MOCK_USER = { id: 'user-1', email: 'u@example.com', provider: 'dev' };

type Row = {
  userId: string;
  activeProgram: string | null;
  workoutSchedule: unknown;
  defaultWeightIncrement: number | null;
  unit: string | null;
};

function makePrismaMock(): { service: PrismaService; store: Map<string, Row> } {
  const store = new Map<string, Row>();
  const service = {
    // The controller routes repository construction through clientForRequest() (RLS); with no
    // active request transaction it returns the base client — here, the mock itself.
    clientForRequest() {
      return this;
    },
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
              };
          store.set(where.userId, next);
          return next;
        },
      ),
    },
  } as unknown as PrismaService;
  return { service, store };
}

describe('UserSettingsController', () => {
  let controller: UserSettingsController;
  let prismaMock: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prismaMock = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserSettingsController],
      providers: [{ provide: PrismaService, useValue: prismaMock.service }],
    }).compile();
    controller = module.get(UserSettingsController);
  });

  it('returns null schedule for a fresh user', async () => {
    const result = await controller.getSettings(MOCK_USER);
    expect(result).toEqual({
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: null,
      unit: null,
    });
  });

  it('persists a defaultWeightIncrement and reads it back', async () => {
    const dto = plainToInstance(UpdateSettingsDto, { defaultWeightIncrement: 0.625 });
    const errors = await validate(dto);
    expect(errors).toEqual([]);

    const patched = await controller.updateSettings(MOCK_USER, dto);
    expect(patched.defaultWeightIncrement).toBe(0.625);

    const fetched = await controller.getSettings(MOCK_USER);
    expect(fetched.defaultWeightIncrement).toBe(0.625);
  });

  it('clears defaultWeightIncrement when patched with null', async () => {
    prismaMock.store.set(MOCK_USER.id, {
      userId: MOCK_USER.id,
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: 2.5,
      unit: null,
    });
    const dto = plainToInstance(UpdateSettingsDto, { defaultWeightIncrement: null });
    const errors = await validate(dto);
    expect(errors).toEqual([]);
    const result = await controller.updateSettings(MOCK_USER, dto);
    expect(result.defaultWeightIncrement).toBeNull();
  });

  it('persists a unit preference and reads it back', async () => {
    const dto = plainToInstance(UpdateSettingsDto, { unit: 'kg' });
    const errors = await validate(dto);
    expect(errors).toEqual([]);

    const patched = await controller.updateSettings(MOCK_USER, dto);
    expect(patched.unit).toBe('kg');

    const fetched = await controller.getSettings(MOCK_USER);
    expect(fetched.unit).toBe('kg');
  });

  it('clears the unit preference when patched with null', async () => {
    prismaMock.store.set(MOCK_USER.id, {
      userId: MOCK_USER.id,
      activeProgram: null,
      workoutSchedule: null,
      defaultWeightIncrement: null,
      unit: 'kg',
    });
    const dto = plainToInstance(UpdateSettingsDto, { unit: null });
    const errors = await validate(dto);
    expect(errors).toEqual([]);
    const result = await controller.updateSettings(MOCK_USER, dto);
    expect(result.unit).toBeNull();
  });

  it('persists a fixed schedule and reads it back', async () => {
    const dto = plainToInstance(UpdateSettingsDto, {
      workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
    });
    const errors = await validate(dto);
    expect(errors).toEqual([]);

    const patched = await controller.updateSettings(MOCK_USER, dto);
    expect(patched.workoutSchedule).toEqual({ type: 'fixed', days: [0, 2, 4] });

    const fetched = await controller.getSettings(MOCK_USER);
    expect(fetched.workoutSchedule).toEqual({ type: 'fixed', days: [0, 2, 4] });
  });

  it('returns null when the DB row holds a malformed schedule', async () => {
    // Simulates a row written by a pre-validator code path or a manual edit. The
    // repository's parseSchedule guard should coerce to null rather than letting
    // malformed JSON reach the client.
    prismaMock.store.set(MOCK_USER.id, {
      userId: MOCK_USER.id,
      activeProgram: null,
      workoutSchedule: { type: 'fixed', days: [0, 99] },
      defaultWeightIncrement: null,
      unit: null,
    });
    const result = await controller.getSettings(MOCK_USER);
    expect(result.workoutSchedule).toBeNull();
  });

  it('clears the schedule when patched with null', async () => {
    prismaMock.store.set(MOCK_USER.id, {
      userId: MOCK_USER.id,
      activeProgram: null,
      workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
      defaultWeightIncrement: null,
      unit: null,
    });
    const dto = plainToInstance(UpdateSettingsDto, { workoutSchedule: null });
    const errors = await validate(dto);
    expect(errors).toEqual([]);
    const result = await controller.updateSettings(MOCK_USER, dto);
    expect(result.workoutSchedule).toBeNull();
  });

  it('persists a rotating schedule', async () => {
    const dto = plainToInstance(UpdateSettingsDto, {
      workoutSchedule: {
        type: 'rotating',
        weeks: [
          [0, 2, 4, 5],
          [1, 3, 5],
        ],
      },
    });
    const errors = await validate(dto);
    expect(errors).toEqual([]);

    const patched = await controller.updateSettings(MOCK_USER, dto);
    expect(patched.workoutSchedule).toEqual({
      type: 'rotating',
      weeks: [
        [0, 2, 4, 5],
        [1, 3, 5],
      ],
    });
  });
});

describe('UpdateSettingsDto validation', () => {
  async function check(body: unknown): Promise<string[]> {
    const dto = plainToInstance(UpdateSettingsDto, body);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: false });
    const flatten = (errs: typeof errors): string[] =>
      errs.flatMap((e) => [
        ...Object.values(e.constraints ?? {}),
        ...flatten(e.children ?? []),
      ]);
    return flatten(errors);
  }

  it('accepts a fixed schedule with valid days', async () => {
    expect(await check({ workoutSchedule: { type: 'fixed', days: [0, 2, 4] } })).toEqual([]);
  });

  it('rejects a fixed schedule with an out-of-range day index', async () => {
    const errs = await check({ workoutSchedule: { type: 'fixed', days: [0, 7] } });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a fixed schedule with duplicate days', async () => {
    const errs = await check({ workoutSchedule: { type: 'fixed', days: [0, 0, 2] } });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a rotating schedule with an empty week', async () => {
    const errs = await check({ workoutSchedule: { type: 'rotating', weeks: [[0, 2], []] } });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects an unknown schedule type', async () => {
    const errs = await check({ workoutSchedule: { type: 'weird', days: [0] } });
    expect(errs.length).toBeGreaterThan(0);
  });

  it.each([0.625, 1.25, 2.5, 5])('accepts %s as a valid defaultWeightIncrement', async (value) => {
    expect(await check({ defaultWeightIncrement: value })).toEqual([]);
  });

  it('accepts an explicit null to clear defaultWeightIncrement', async () => {
    expect(await check({ defaultWeightIncrement: null })).toEqual([]);
  });

  it.each([0, 1, 3, 10, -2.5])('rejects %s as an out-of-range defaultWeightIncrement', async (value) => {
    const errs = await check({ defaultWeightIncrement: value });
    expect(errs.length).toBeGreaterThan(0);
  });

  it.each(['lbs', 'kg'])('accepts %s as a valid unit', async (value) => {
    expect(await check({ unit: value })).toEqual([]);
  });

  it('accepts an explicit null to clear unit', async () => {
    expect(await check({ unit: null })).toEqual([]);
  });

  it.each(['pounds', 'KG', ''])('rejects %s as an invalid unit', async (value) => {
    const errs = await check({ unit: value });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('accepts an empty patch (no-op)', async () => {
    expect(await check({})).toEqual([]);
  });

  it('accepts an explicit null to clear the schedule', async () => {
    expect(await check({ workoutSchedule: null })).toEqual([]);
  });

  it('rejects a fixed schedule that also carries weeks', async () => {
    const errs = await check({
      workoutSchedule: { type: 'fixed', days: [0, 2], weeks: [[1, 3]] },
    });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a rotating schedule that also carries days', async () => {
    const errs = await check({
      workoutSchedule: { type: 'rotating', weeks: [[0, 2]], days: [1] },
    });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a fixed schedule with no days field', async () => {
    const errs = await check({ workoutSchedule: { type: 'fixed' } });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a non-object workoutSchedule (string)', async () => {
    const errs = await check({ workoutSchedule: 'hacker' });
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects a non-object workoutSchedule (number)', async () => {
    const errs = await check({ workoutSchedule: 42 });
    expect(errs.length).toBeGreaterThan(0);
  });

  // Locks in the production pipe config from apps/api/src/main.ts. If main.ts ever weakens
  // these flags (e.g., drops `forbidNonWhitelisted`), this test fails — without it, the DTO's
  // implicit reliance on whitelist behavior to strip/reject unknown nested keys would silently
  // degrade. Previously kept in sync by convention (a literal manually kept "byte-identical to
  // main.ts"); now sourced from the same VALIDATION_PIPE_OPTIONS constant main.ts uses, so this
  // is a mechanical guarantee rather than a maintained-by-hand one (#893 review).
  describe('production ValidationPipe wiring', () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const meta = { type: 'body' as const, metatype: UpdateSettingsDto };

    it('rejects an unknown top-level sibling field', async () => {
      await expect(
        pipe.transform({ workoutSchedule: { type: 'fixed', days: [0] }, evil: 'x' }, meta),
      ).rejects.toThrow();
    });

    it('rejects an unknown field nested inside workoutSchedule', async () => {
      await expect(
        pipe.transform(
          { workoutSchedule: { type: 'fixed', days: [0], evil: 'x' } },
          meta,
        ),
      ).rejects.toThrow();
    });

    it('accepts a clean payload', async () => {
      await expect(
        pipe.transform({ workoutSchedule: { type: 'fixed', days: [0, 2, 4] } }, meta),
      ).resolves.toBeDefined();
    });
  });
});
