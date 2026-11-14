import 'reflect-metadata';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyRequest } from 'fastify';
import { LiftRecord, Weekday } from '@lifting-logbook/core';
import { CustomLift, LiftModification, LiftModificationMaxMode, MacrocycleOrigin } from '@lifting-logbook/types';
import { InMemoryImportBatchRepository } from '../adapters/in-memory/import-batch.adapter';
import { InMemoryMacrocycleRepository, macrocycleRowFixture } from '../adapters/in-memory/macrocycle.adapter';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import { ProgramNotFoundError } from '../ports/errors';
import { ICustomLiftRepository } from '../ports/ICustomLiftRepository';
import { IMacrocycleDashboardRepository } from '../ports/IMacrocycleDashboardRepository';
import { ILiftRecordRepository } from '../ports/ILiftRecordRepository';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { RLS_TX_TIMEOUT_KEY } from '../adapters/prisma/rls-context';
import { IMPORT_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';
import { LiftRecordsController } from './lift-records.controller';

/** Builds a fake FastifyRequest whose req.file() resolves to the given CSV text. */
function csvUploadRequest(csvText: string): FastifyRequest {
  return {
    file: async () => ({
      toBuffer: async () => Buffer.from(csvText, 'utf-8'),
      file: { truncated: false },
    }),
  } as unknown as FastifyRequest;
}

const MOCK_USER = { id: 'test-user', email: 'test@example.com', provider: 'dev' };

const macrocycleRow = (macrocycleNum: number, origin: MacrocycleOrigin): MacrocycleRow =>
  macrocycleRowFixture(macrocycleNum, { origin, status: origin === 'live' ? 'in-progress' : 'completed' });

const SEED_DASHBOARD = {
  program: '5-3-1',
  macrocycleUnit: 'week' as const,
  macrocycleNum: 4,
  macrocycleDate: new Date('2026-04-20T00:00:00.000Z'),
  sheetName: '',
  macrocycleStartWeekday: Weekday.Monday,
};

const SEED_RECORD = {
  program: '5-3-1',
  macrocycleNum: 4,
  workoutNum: 1,
  date: new Date('2026-04-20T00:00:00.000Z'),
  lift: 'Bench Press',
  setNum: 1,
  weight: 180,
  reps: 5,
  notes: '',
};

describe('LiftRecordsController', () => {
  let controller: LiftRecordsController;
  let liftRecordRepo: jest.Mocked<ILiftRecordRepository>;
  let dashboardRepo: jest.Mocked<IMacrocycleDashboardRepository>;
  let customLiftRepo: jest.Mocked<ICustomLiftRepository>;
  let factory: jest.Mocked<IRepositoryFactory>;
  let macrocycleRepo: InMemoryMacrocycleRepository;

  beforeEach(async () => {
    liftRecordRepo = {
      getLiftRecords: jest.fn(),
      appendLiftRecords: jest.fn(),
      updateLiftRecord: jest.fn(),
      findStoredSets: jest.fn().mockResolvedValue([]),
      deleteLiftRecordsByNaturalKeys: jest.fn().mockResolvedValue(0),
      getMacrocycleDateRanges: jest.fn().mockResolvedValue(new Map()),
    };
    dashboardRepo = {
      getMacrocycleDashboard: jest.fn().mockRejectedValue(new ProgramNotFoundError('5-3-1')),
      saveMacrocycleDashboard: jest.fn(),
    };
    customLiftRepo = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    // Macrocycle 4 is the live one; 3 is imported history.
    macrocycleRepo = new InMemoryMacrocycleRepository([macrocycleRow(4, 'live'), macrocycleRow(3, 'imported')]);
    factory = {
      forUser: jest.fn().mockResolvedValue({
        liftRecord: liftRecordRepo,
        macrocycle: macrocycleRepo,
        macrocycleDashboard: dashboardRepo,
        customLift: customLiftRepo,
        importBatch: new InMemoryImportBatchRepository(),
      }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LiftRecordsController],
      providers: [{ provide: REPOSITORY_FACTORY, useValue: factory }],
    }).compile();
    controller = module.get(LiftRecordsController);
  });

  describe('GET lift-records', () => {
    it('fetches lift records scoped to current macrocycle', async () => {
      dashboardRepo.getMacrocycleDashboard.mockResolvedValue(SEED_DASHBOARD);
      liftRecordRepo.getLiftRecords.mockResolvedValue([SEED_RECORD]);

      const result = await controller.getLiftRecords('5-3-1', MOCK_USER);

      expect(liftRecordRepo.getLiftRecords).toHaveBeenCalledWith('5-3-1', 4);
      expect(result).toHaveLength(1);
      expect(result[0]?.lift).toBe('Bench Press');
      expect(result[0]?.date).toBe('2026-04-20');
    });

    it('returns no records, rather than a 404, for a program with no current macrocycle (#1300)', async () => {
      // dashboardRepo rejects with ProgramNotFoundError by default.
      await expect(controller.getLiftRecords('5-3-1', MOCK_USER)).resolves.toEqual([]);
      expect(liftRecordRepo.getLiftRecords).not.toHaveBeenCalled();
    });
  });

  describe('POST lift-records with modifications', () => {
    const modification = (id: string, lift: string, maxMode: LiftModificationMaxMode): LiftModification => ({
      id,
      userId: MOCK_USER.id,
      lift,
      name: id,
      description: '',
      maxMode,
      archivedAt: null,
      createdAt: new Date(),
    });
    const body = (modifications: string[]) => ({
      macrocycleNum: 4,
      workoutNum: 1,
      date: '2026-04-20',
      lift: 'Bench Press',
      setNum: 1,
      weight: 180,
      reps: 5,
      modifications,
    });

    beforeEach(() => {
      factory.forUser.mockResolvedValue({
        liftRecord: liftRecordRepo,
        macrocycle: macrocycleRepo,
        macrocycleDashboard: dashboardRepo,
        customLift: customLiftRepo,
        importBatch: new InMemoryImportBatchRepository(),
        liftModification: {
          list: jest.fn().mockResolvedValue([
            modification('own-1', 'bench-press', 'own'),
            modification('own-2', 'bench-press', 'own'),
            modification('lift-1', 'bench-press', 'lift'),
            modification('squat-1', 'squat', 'none'),
          ]),
        },
      } as unknown as RepositoryBundle);
      liftRecordRepo.appendLiftRecords.mockResolvedValue(1);
    });

    it('rejects a set with two `own` modifications, writing nothing', async () => {
      await expect(controller.createLiftRecord('5-3-1', body(['own-1', 'own-2']), MOCK_USER, 'm-4')).rejects.toThrow(
        BadRequestException,
      );
      expect(liftRecordRepo.appendLiftRecords).not.toHaveBeenCalled();
    });

    it('rejects an unknown id and a modification of another lift', async () => {
      await expect(controller.createLiftRecord('5-3-1', body(['nope']), MOCK_USER, 'm-4')).rejects.toThrow(BadRequestException);
      await expect(controller.createLiftRecord('5-3-1', body(['squat-1']), MOCK_USER, 'm-4')).rejects.toThrow(BadRequestException);
      expect(liftRecordRepo.appendLiftRecords).not.toHaveBeenCalled();
    });

    it('accepts one `own` beside another mode, and writes the ids', async () => {
      const result = await controller.createLiftRecord('5-3-1', body(['own-1', 'lift-1']), MOCK_USER, 'm-4');
      expect(liftRecordRepo.appendLiftRecords).toHaveBeenCalledWith('5-3-1', [
        expect.objectContaining({ modifications: ['own-1', 'lift-1'] }),
      ]);
      expect(result.modifications).toEqual([
        { id: 'own-1', name: 'own-1' },
        { id: 'lift-1', name: 'lift-1' },
      ]);
    });
  });

  describe('POST lift-records', () => {
    it('appends the record and returns the serialized response', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(1);

      const result = await controller.createLiftRecord('5-3-1', {
        program: '5-3-1',
        macrocycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Bench Press',
        setNum: 1,
        weight: 180,
        reps: 5,
      }, MOCK_USER, 'm-4');

      expect(liftRecordRepo.appendLiftRecords).toHaveBeenCalledWith(
        '5-3-1',
        expect.arrayContaining([
          expect.objectContaining({ lift: 'Bench Press', setNum: 1, notes: '' }),
        ]),
      );
      expect(result.id).toBe('5-3-1-4-1-20260420-Bench Press-1');
      expect(result.notes).toBe('');
    });

    it('forwards optional notes to the record', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(1);

      const result = await controller.createLiftRecord('5-3-1', {
        program: '5-3-1',
        macrocycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Squat',
        setNum: 2,
        weight: 225,
        reps: 5,
        notes: 'felt good',
      }, MOCK_USER, 'm-4');

      expect(result.notes).toBe('felt good');
    });

    // Regression for #893's review round 2: a defensive guard independent of
    // whatever CreateLiftRecordDto's decorators do or don't catch. Calling the
    // controller directly (as this suite does throughout) bypasses the DTO/pipe
    // layer entirely, so this is the one place that exercises the controller's own
    // last-resort check in isolation.
    it('throws BadRequestException when date produces an Invalid Date, independent of DTO validation', async () => {
      await expect(
        controller.createLiftRecord('5-3-1', {
          program: '5-3-1',
          macrocycleNum: 4,
          workoutNum: 1,
          date: 'garbage-value',
          lift: 'Bench Press',
          setNum: 1,
          weight: 180,
          reps: 5,
        }, MOCK_USER, 'm-4'),
      ).rejects.toThrow(BadRequestException);
      expect(liftRecordRepo.appendLiftRecords).not.toHaveBeenCalled();
    });

    // Regression for #893's review round 3: body.program is unused by the write
    // itself (the route :program param is authoritative below) but is now a
    // declared, validated part of the accepted contract — silently discarding a
    // *conflicting* value would let a client bug write real data into the wrong
    // program with a 201 giving no indication anything was wrong.
    it('throws BadRequestException when body.program conflicts with the route :program param', async () => {
      await expect(
        controller.createLiftRecord('5-3-1', {
          program: 'some-other-program',
          macrocycleNum: 4,
          workoutNum: 1,
          date: '2026-04-20',
          lift: 'Bench Press',
          setNum: 1,
          weight: 180,
          reps: 5,
        }, MOCK_USER, 'm-4'),
      ).rejects.toThrow(BadRequestException);
      expect(liftRecordRepo.appendLiftRecords).not.toHaveBeenCalled();
    });

    // Regression for issue #884: the single-record path shares appendLiftRecords'
    // skipDuplicates semantics with the import path, so a collision must not
    // silently no-op and report success unless it's an idempotent retry (the
    // payload matches what's already stored — see the next test).
    it('throws ConflictException when the write collides with different data', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(0);
      liftRecordRepo.getLiftRecords.mockResolvedValue([
        { ...SEED_RECORD, lift: 'Bench Press', setNum: 1, weight: 999, reps: 1 },
      ]);

      await expect(
        controller.createLiftRecord('5-3-1', {
          program: '5-3-1',
          macrocycleNum: 4,
          workoutNum: 1,
          date: '2026-04-20',
          lift: 'Bench Press',
          setNum: 1,
          weight: 180,
          reps: 5,
        }, MOCK_USER, 'm-4'),
      ).rejects.toThrow(ConflictException);
    });

    // A retry whose response was lost (timeout, dropped connection) resubmits
    // identical data — that must succeed, not stay permanently stuck on a
    // conflict the client has no way to resolve.
    it('returns the existing record instead of a conflict when the collision is an idempotent retry', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(0);
      const stored = { ...SEED_RECORD, lift: 'Bench Press', setNum: 1, weight: 180, reps: 5, notes: '' };
      liftRecordRepo.getLiftRecords.mockResolvedValue([stored]);

      const result = await controller.createLiftRecord('5-3-1', {
        program: '5-3-1',
        macrocycleNum: 4,
        workoutNum: 1,
        date: '2026-04-20',
        lift: 'Bench Press',
        setNum: 1,
        weight: 180,
        reps: 5,
      }, MOCK_USER, 'm-4');

      expect(result.weight).toBe(180);
      expect(result.reps).toBe(5);
    });
  });

  // Prior to #911, this endpoint's only coverage was indirect (it shares
  // validateLiftImport with the Smart Import wizard's tests) — it had zero
  // dedicated tests of its own despite being a distinct, remap-free code path.
  describe('POST lift-records/import', () => {
    const IMPORT_CSV_HEADER = 'Program,Cycle #,Workout #,Date,Lift,Set #,Weight,Reps,Notes';

    // Regression for #911: this endpoint has no interactive remap step, so an
    // unrecognized lift must never leak the strict validator's internal
    // "... is not in the slot map" wording to the end user.
    it('surfaces a humanized message for an unrecognized lift, not raw slot-map jargon', async () => {
      const csv = [
        IMPORT_CSV_HEADER,
        '5-3-1,1,1,2026-01-01,Totally Unknown Lift,1,180,5,',
      ].join('\n');

      let caught: unknown;
      try {
        await controller.importLiftRecords('5-3-1', csvUploadRequest(csv), MOCK_USER);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const response = (caught as BadRequestException).getResponse() as {
        errors: { message: string }[];
      };
      expect(response.errors[0]!.message).toContain('Totally Unknown Lift');
      expect(response.errors[0]!.message).not.toMatch(/slot map/i);
      expect(liftRecordRepo.appendLiftRecords).not.toHaveBeenCalled();
    });

    // #911: the effective slot map now folds in the user's custom lifts, so a row
    // whose raw text already exactly matches an existing custom lift's name
    // resolves without requiring any manual remap (this endpoint has no remap UI).
    it('resolves a row whose lift name matches an existing custom lift, with no override needed', async () => {
      const customLift: CustomLift = {
        id: 'custom-wide-grip-cbl-curls',
        name: 'Wide-Grip CBL Curls',
        classification: 'accessory',
        movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
        userId: MOCK_USER.id,
        isCustom: true,
        createdAt: new Date('2026-01-01'),
      };
      customLiftRepo.list.mockResolvedValue([customLift]);
      liftRecordRepo.appendLiftRecords.mockResolvedValue(1);
      const csv = [
        IMPORT_CSV_HEADER,
        '5-3-1,1,1,2026-01-01,Wide-Grip CBL Curls,1,90,10,',
      ].join('\n');

      const result = await controller.importLiftRecords('5-3-1', csvUploadRequest(csv), MOCK_USER);

      expect(result.written).toBe(1);
      expect(liftRecordRepo.appendLiftRecords).toHaveBeenCalledWith(
        '5-3-1',
        expect.arrayContaining([expect.objectContaining({ lift: 'custom-wide-grip-cbl-curls' })]),
      );
    });

    // A file number only groups rows (#1199): one the program doesn't have gets a `legacy`
    // macrocycle dated by its rows, written past every stored one (ADR-042). It starts before
    // them, so renumbering then moves it to 1 (#1200).
    it('gives a new file number a legacy macrocycle, dated by its rows', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(2);
      const csv = [
        IMPORT_CSV_HEADER,
        '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,',
        '5-3-1,1,2,2026-01-08,Bench P.,1,185,5,',
      ].join('\n');

      await controller.importLiftRecords('5-3-1', csvUploadRequest(csv), MOCK_USER);

      expect(await macrocycleRepo.findByNumber('5-3-1', 1)).toMatchObject({
        origin: 'legacy',
        status: 'unknown',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: new Date('2026-01-08T00:00:00.000Z'),
      });
      expect(liftRecordRepo.appendLiftRecords).toHaveBeenCalledWith('5-3-1', [
        expect.objectContaining({ macrocycleNum: 5, workoutNum: 1 }),
        expect.objectContaining({ macrocycleNum: 5, workoutNum: 2 }),
      ]);
    });

    // Rows never join an imported macrocycle; the owner chose a new legacy one over a 409 (#1199).
    it('puts rows numbered like an imported macrocycle in a new legacy one', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(1);
      const csv = [IMPORT_CSV_HEADER, '5-3-1,3,1,2026-01-01,Bench P.,1,180,5,'].join('\n');

      await controller.importLiftRecords('5-3-1', csvUploadRequest(csv), MOCK_USER);

      expect(liftRecordRepo.appendLiftRecords).toHaveBeenCalledWith('5-3-1', [expect.objectContaining({ macrocycleNum: 5 })]);
      // Dated first, the new legacy macrocycle is renumbered to 1, and the imported one to 2 (#1200).
      expect(await macrocycleRepo.findByNumber('5-3-1', 1)).toMatchObject({ origin: 'legacy' });
      expect(await macrocycleRepo.findByNumber('5-3-1', 2)).toMatchObject({ origin: 'imported' });
    });

    it('writes one row for a set the file names under two spellings of a lift (#1191)', async () => {
      liftRecordRepo.appendLiftRecords.mockResolvedValue(3);
      const csv = [
        IMPORT_CSV_HEADER,
        '5-3-1,1,1,2026-01-01,Calf Raises,1,100,10,',
        '5-3-1,1,1,2026-01-01,calf-raise,1,100,10,',
        '5-3-1,1,1,2026-01-01,Pull-up,1,25,8,',
        '5-3-1,1,1,2026-01-01,Weighted Pull-ups,1,45,5,',
      ].join('\n');

      const result = await controller.importLiftRecords('5-3-1', csvUploadRequest(csv), MOCK_USER);

      const written = liftRecordRepo.appendLiftRecords.mock.calls.flatMap(([, rows]) => rows);
      expect(written.map((r) => r.lift)).toEqual(['Calf Raises', 'Pull-up', 'Weighted Pull-ups']);
      expect(result.written).toBe(3);
      expect(result.skipped).toEqual([expect.objectContaining({ row: 2 })]);
    });

    // #1158: the skip stays keyed by the id, but the upload form shows the label.
    it('labels a skipped custom-lift row with its name, not its id', async () => {
      const customLift: CustomLift = {
        id: 'custom-wide-grip-cbl-curls',
        name: 'Wide-Grip CBL Curls',
        classification: 'accessory',
        movementProfile: { patterns: [], jointActions: [], complexity: 'simple' },
        userId: MOCK_USER.id,
        isCustom: true,
        createdAt: new Date('2026-01-01'),
      };
      customLiftRepo.list.mockResolvedValue([customLift]);
      liftRecordRepo.findStoredSets.mockImplementation(async (slots) => slots as LiftRecord[]);
      liftRecordRepo.appendLiftRecords.mockResolvedValue(0);
      const csv = [
        IMPORT_CSV_HEADER,
        '5-3-1,1,1,2026-01-01,Wide-Grip CBL Curls,1,90,10,',
      ].join('\n');

      const result = await controller.importLiftRecords('5-3-1', csvUploadRequest(csv), MOCK_USER);

      expect(result.skipped).toEqual([
        {
          row: 1,
          naturalKey: '1:1:20260101:custom-wide-grip-cbl-curls:1',
          label: 'Wide-Grip CBL Curls · macrocycle 1 workout 1 set 1 (20260101)',
        },
      ]);
    });

    // #1162: the same for a built-in lift, which is stored under its catalog id.
    it('labels a skipped built-in row with its name, not its id', async () => {
      liftRecordRepo.findStoredSets.mockImplementation(async (slots) => slots as LiftRecord[]);
      liftRecordRepo.appendLiftRecords.mockResolvedValue(0);
      const csv = [IMPORT_CSV_HEADER, '5-3-1,1,1,2026-01-01,Bench P.,1,180,5,'].join('\n');

      const result = await controller.importLiftRecords('5-3-1', csvUploadRequest(csv), MOCK_USER);

      expect(result.skipped).toEqual([
        {
          row: 1,
          naturalKey: '1:1:20260101:bench-press:1',
          label: 'Bench Press · macrocycle 1 workout 1 set 1 (20260101)',
        },
      ]);
    });
  });

  describe('PATCH lift-records/:id', () => {
    it('returns the updated record when found', async () => {
      const updated = { ...SEED_RECORD, weight: 185, reps: 4 };
      liftRecordRepo.updateLiftRecord.mockResolvedValue(updated);

      const result = await controller.updateLiftRecord(
        '5-3-1',
        '5-3-1-4-1-20260420-Bench Press-1',
        { weight: 185, reps: 4 },
        MOCK_USER, 'm-4',
      );

      expect(liftRecordRepo.updateLiftRecord).toHaveBeenCalledWith(
        '5-3-1',
        '5-3-1-4-1-20260420-Bench Press-1',
        { weight: 185, reps: 4 },
      );
      expect(result.weight).toBe(185);
      expect(result.reps).toBe(4);
    });

    it('throws NotFoundException when record does not exist', async () => {
      liftRecordRepo.updateLiftRecord.mockResolvedValue(null);

      await expect(
        controller.updateLiftRecord('5-3-1', 'unknown-id', { weight: 200 }, MOCK_USER),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // Imported history is read-only, and an id the program doesn't have is a 404 (ADR-042).
  describe('macrocycle guard', () => {
    const set = (macrocycleNum: number) => ({
      program: '5-3-1',
      macrocycleNum,
      workoutNum: 1,
      date: '2026-04-20',
      lift: 'Bench Press',
      setNum: 1,
      weight: 180,
      reps: 5,
    });

    it.each([
      [3, 409, 'macrocycle-read-only'],
      [9, 404, 'macrocycle-not-found'],
    ])('rejects a set on macrocycle %i with %i', async (macrocycleNum, status, code) => {
      await expect(controller.createLiftRecord('5-3-1', set(macrocycleNum), MOCK_USER, `m-${macrocycleNum}`)).rejects.toMatchObject({
        status,
        response: { code },
      });
      expect(liftRecordRepo.appendLiftRecords).not.toHaveBeenCalled();
    });

    it.each([
      [3, 409, 'macrocycle-read-only'],
      [9, 404, 'macrocycle-not-found'],
    ])('rejects an edit on macrocycle %i with %i', async (macrocycleNum, status, code) => {
      await expect(
        controller.updateLiftRecord('5-3-1', `5-3-1-${macrocycleNum}-1-20260420-Bench Press-1`, { weight: 185 }, MOCK_USER, `m-${macrocycleNum}`),
      ).rejects.toMatchObject({ status, response: { code } });
      expect(liftRecordRepo.updateLiftRecord).not.toHaveBeenCalled();
    });
  });
});

// Standalone, not nested in the DI-fixture describe above — this asserts only
// static decorator metadata, so it needs no TestingModule setup, mirroring
// import.controller.spec.ts's own equivalents.
describe('LiftRecordsController RLS transaction budget', () => {
  // #911 review, eighth pass: this endpoint runs the same bulk validate +
  // createMany shape of work as ImportController's own import path (which
  // already carries this same annotation, asserted by
  // import.controller.spec.ts) inside the same per-request RLS transaction —
  // without it, a large (within-limit) import falls through to the 15s
  // DEFAULT_RLS_TX_TIMEOUT_MS instead of the wider import budget (#532).
  it('annotates the import handler with the import transaction budget', () => {
    const timeout = Reflect.getMetadata(
      RLS_TX_TIMEOUT_KEY,
      LiftRecordsController.prototype.importLiftRecords,
    );
    expect(timeout).toBe(IMPORT_TX_TIMEOUT_MS);
  });
});
