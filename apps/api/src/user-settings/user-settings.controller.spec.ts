import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UserSettingsResponse } from '@lifting-logbook/types';
import { IUserSettingsRepository } from '../ports/IUserSettingsRepository';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';
import { UserSettingsController } from './user-settings.controller';
import { UpdateSettingsDto } from './update-settings.dto';

const MOCK_USER = { id: 'user-1', email: 'u@example.com', provider: 'dev' };

const EMPTY_SETTINGS: UserSettingsResponse = {
  activeProgram: null,
  workoutSchedule: null,
  defaultWeightIncrement: null,
  unit: null,
};

describe('UserSettingsController', () => {
  let controller: UserSettingsController;
  let userSettings: jest.Mocked<IUserSettingsRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;

  beforeEach(async () => {
    userSettings = {
      getSettings: jest.fn().mockResolvedValue(EMPTY_SETTINGS),
      upsertSettings: jest.fn().mockResolvedValue(EMPTY_SETTINGS),
    };
    factory = {
      forUser: jest.fn().mockResolvedValue({ userSettings }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserSettingsController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(UserSettingsController);
  });

  describe('getSettings', () => {
    it('resolves the repository for the current user and returns its settings', async () => {
      userSettings.getSettings.mockResolvedValue({
        activeProgram: '5-3-1',
        workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
        defaultWeightIncrement: 0.625,
        unit: 'kg',
      });

      const result = await controller.getSettings(MOCK_USER);

      expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
      expect(result).toEqual({
        activeProgram: '5-3-1',
        workoutSchedule: { type: 'fixed', days: [0, 2, 4] },
        defaultWeightIncrement: 0.625,
        unit: 'kg',
      });
    });
  });

  describe('updateSettings', () => {
    it('resolves the repository for the current user and forwards the patch', async () => {
      const dto = plainToInstance(UpdateSettingsDto, { defaultWeightIncrement: 0.625 });
      const errors = await validate(dto);
      expect(errors).toEqual([]);
      userSettings.upsertSettings.mockResolvedValue({ ...EMPTY_SETTINGS, defaultWeightIncrement: 0.625 });

      const result = await controller.updateSettings(MOCK_USER, dto);

      expect(factory.forUser).toHaveBeenCalledWith(MOCK_USER);
      expect(userSettings.upsertSettings).toHaveBeenCalledWith(dto);
      expect(result.defaultWeightIncrement).toBe(0.625);
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

  it('accepts a rotating schedule with valid weeks', async () => {
    expect(
      await check({
        workoutSchedule: {
          type: 'rotating',
          weeks: [
            [0, 2, 4, 5],
            [1, 3, 5],
          ],
        },
      }),
    ).toEqual([]);
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

  it('accepts a valid activeProgram', async () => {
    expect(await check({ activeProgram: '5-3-1' })).toEqual([]);
  });

  it('rejects a null activeProgram — it has no clear-via-null semantics', async () => {
    const errs = await check({ activeProgram: null });
    expect(errs.length).toBeGreaterThan(0);
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
