import { PrismaClient } from '@prisma/client';
// Prisma 5.x — error classes moved off the Prisma namespace
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { LiftRecord } from '@lifting-logbook/core';
import { PrismaLiftRecordRepository } from './lift-record.repository';

const BASE_ROW = {
  id: 'row-id-1',
  userId: 'user-1',
  program: '5-3-1',
  cycleNum: 2,
  workoutNum: 3,
  date: new Date('2026-04-01T00:00:00.000Z'),
  lift: 'Bench Press',
  setNum: 1,
  weight: 180,
  reps: 5,
  notes: '',
};

function liftRecord(overrides: Partial<LiftRecord> = {}): LiftRecord {
  return {
    program: '5-3-1',
    cycleNum: 2,
    workoutNum: 3,
    date: new Date('2026-04-01T00:00:00.000Z'),
    lift: 'Bench Press',
    setNum: 1,
    weight: 180,
    reps: 5,
    notes: '',
    ...overrides,
  };
}

function makePrisma(overrides: Partial<PrismaClient> = {}): PrismaClient {
  return {
    liftRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

describe('PrismaLiftRecordRepository', () => {
  describe('updateLiftRecord — ID parsing and DB dispatch', () => {
    it('updates a record with a plain program name', async () => {
      const prisma = makePrisma();
      (prisma.liftRecord.update as jest.Mock).mockResolvedValue({ ...BASE_ROW, weight: 185 });
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      const result = await repo.updateLiftRecord('5-3-1', '5-3-1-2-3-20260401-Bench Press-1', {
        weight: 185,
      });

      expect(prisma.liftRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_program_cycleNum_workoutNum_date_lift_setNum: {
              userId: 'user-1',
              program: '5-3-1',
              cycleNum: 2,
              workoutNum: 3,
              date: new Date('2026-04-01T00:00:00.000Z'),
              lift: 'Bench Press',
              setNum: 1,
            },
          },
        }),
      );
      expect(result?.weight).toBe(185);
    });

    it('correctly parses a hyphenated lift name (e.g. Chin-up)', async () => {
      const row = { ...BASE_ROW, lift: 'Chin-up', setNum: 2 };
      const prisma = makePrisma();
      (prisma.liftRecord.update as jest.Mock).mockResolvedValue(row);
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      await repo.updateLiftRecord('5-3-1', '5-3-1-2-3-20260401-Chin-up-2', { reps: 8 });

      expect(prisma.liftRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_program_cycleNum_workoutNum_date_lift_setNum: expect.objectContaining({
              date: new Date('2026-04-01T00:00:00.000Z'),
              lift: 'Chin-up',
              setNum: 2,
            }),
          },
        }),
      );
    });

    it('correctly parses a multi-word hyphenated lift name (e.g. Romanian Dead-lift)', async () => {
      const row = { ...BASE_ROW, lift: 'Romanian Dead-lift', setNum: 3 };
      const prisma = makePrisma();
      (prisma.liftRecord.update as jest.Mock).mockResolvedValue(row);
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      await repo.updateLiftRecord('5-3-1', '5-3-1-2-3-20260401-Romanian Dead-lift-3', {
        notes: 'light',
      });

      expect(prisma.liftRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_program_cycleNum_workoutNum_date_lift_setNum: expect.objectContaining({
              date: new Date('2026-04-01T00:00:00.000Z'),
              lift: 'Romanian Dead-lift',
              setNum: 3,
            }),
          },
        }),
      );
    });

    it('returns null when the id prefix does not match the program', async () => {
      const prisma = makePrisma();
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      const result = await repo.updateLiftRecord('5-3-1', 'other-program-1-1-Squat-1', {
        weight: 200,
      });

      expect(result).toBeNull();
      expect(prisma.liftRecord.update).not.toHaveBeenCalled();
    });

    it('returns null for a pre-#884 id with no date segment', async () => {
      const prisma = makePrisma();
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      const result = await repo.updateLiftRecord('5-3-1', '5-3-1-2-3-Squat-1', { weight: 200 });

      expect(result).toBeNull();
      expect(prisma.liftRecord.update).not.toHaveBeenCalled();
    });

    it('returns null when the record does not exist in the DB (P2025)', async () => {
      const prisma = makePrisma();
      const p2025 = new PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.0.0',
      });
      (prisma.liftRecord.update as jest.Mock).mockRejectedValue(p2025);
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      const result = await repo.updateLiftRecord('5-3-1', '5-3-1-2-3-20260401-Squat-1', {
        weight: 200,
      });

      expect(result).toBeNull();
    });

    it('re-throws non-P2025 Prisma errors', async () => {
      const prisma = makePrisma();
      const dbError = new PrismaClientKnownRequestError('Connection error', {
        code: 'P1001',
        clientVersion: '5.0.0',
      });
      (prisma.liftRecord.update as jest.Mock).mockRejectedValue(dbError);
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      await expect(
        repo.updateLiftRecord('5-3-1', '5-3-1-2-3-20260401-Squat-1', { weight: 200 }),
      ).rejects.toThrow(dbError);
    });
  });

  describe('appendLiftRecords', () => {
    it('includes date in the createMany payload', async () => {
      const prisma = makePrisma();
      (prisma.liftRecord.createMany as jest.Mock).mockResolvedValue({ count: 1 });
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      await repo.appendLiftRecords('5-3-1', [liftRecord()]);

      expect(prisma.liftRecord.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ date: new Date('2026-04-01T00:00:00.000Z') })],
          skipDuplicates: true,
        }),
      );
    });

    it('returns the DB insert count', async () => {
      const prisma = makePrisma();
      (prisma.liftRecord.createMany as jest.Mock).mockResolvedValue({ count: 2 });
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      const count = await repo.appendLiftRecords('5-3-1', [
        liftRecord({ date: new Date('2025-12-16') }),
        liftRecord({ date: new Date('2024-01-12') }),
      ]);

      expect(count).toBe(2);
    });
  });

  describe('findExistingRecords', () => {
    it('includes date in the OR-filter clause', async () => {
      const prisma = makePrisma();
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      await repo.findExistingRecords('5-3-1', [liftRecord()]);

      expect(prisma.liftRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              expect.objectContaining({
                cycleNum: 2,
                workoutNum: 3,
                date: new Date('2026-04-01T00:00:00.000Z'),
                lift: 'Bench Press',
                setNum: 1,
              }),
            ],
          }),
        }),
      );
    });

    // Core regression for issue #884: a row already stored on one date must not
    // be reported as "existing" for a candidate sharing every other field but a
    // different date — findMany returning the stored (different-date) row is not
    // enough by itself; the natural-key filter must also disambiguate on read.
    it('does not treat a same-key-different-date candidate as already existing', async () => {
      const stored = { ...BASE_ROW, date: new Date('2025-12-16T00:00:00.000Z') };
      const prisma = makePrisma({
        liftRecord: {
          findMany: jest.fn().mockResolvedValue([stored]),
          createMany: jest.fn(),
          update: jest.fn(),
          deleteMany: jest.fn(),
        },
      } as unknown as Partial<PrismaClient>);
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      const candidate = liftRecord({ date: new Date('2024-01-12') });
      const existing = await repo.findExistingRecords('5-3-1', [candidate]);

      expect(existing).toEqual([]);
    });
  });

  describe('deleteLiftRecordsByNaturalKeys', () => {
    it('includes date in the OR-filter clause', async () => {
      const prisma = makePrisma();
      (prisma.liftRecord.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      await repo.deleteLiftRecordsByNaturalKeys('5-3-1', ['2:3:20260401:Bench Press:1']);

      expect(prisma.liftRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              expect.objectContaining({
                cycleNum: 2,
                workoutNum: 3,
                date: new Date('2026-04-01T00:00:00.000Z'),
                lift: 'Bench Press',
                setNum: 1,
              }),
            ],
          }),
        }),
      );
    });

    it('drops a pre-#884 key with no date segment rather than deleting broadly', async () => {
      const prisma = makePrisma();
      const repo = new PrismaLiftRecordRepository(prisma, 'user-1');

      const count = await repo.deleteLiftRecordsByNaturalKeys('5-3-1', ['2:3:Bench Press:1']);

      expect(count).toBe(0);
      expect(prisma.liftRecord.deleteMany).not.toHaveBeenCalled();
    });
  });
});
