import { BadRequestException } from '@nestjs/common';
import type { PrismaExecutor } from '../adapters/prisma/prisma-tx.util';
import { assignImportDate, assignProgramOptions, customKnownPrograms, importAssignEnabled } from './import-assign';

describe('import-assign helpers (#1253)', () => {
  describe('importAssignEnabled', () => {
    const saved = process.env.IMPORT_ASSIGN_ENABLED;
    afterEach(() => {
      if (saved === undefined) delete process.env.IMPORT_ASSIGN_ENABLED;
      else process.env.IMPORT_ASSIGN_ENABLED = saved;
    });

    it('is on only for "true"', () => {
      delete process.env.IMPORT_ASSIGN_ENABLED;
      expect(importAssignEnabled()).toBe(false);
      process.env.IMPORT_ASSIGN_ENABLED = '1';
      expect(importAssignEnabled()).toBe(false);
      process.env.IMPORT_ASSIGN_ENABLED = 'true';
      expect(importAssignEnabled()).toBe(true);
    });
  });

  describe('assignImportDate', () => {
    // 23:30 UTC on 10 March 2026: a lifter in the US is still on the 10th, one in Auckland on the 11th.
    const now = new Date('2026-03-10T23:30:00Z');

    it("takes the lifter's day within one of the server's", () => {
      expect(assignImportDate('2026-03-09', now).toISOString()).toBe('2026-03-09T00:00:00.000Z');
      expect(assignImportDate('2026-03-11', now).toISOString()).toBe('2026-03-11T00:00:00.000Z');
    });

    it("uses the server's day when none is sent", () => {
      expect(assignImportDate(undefined, now).toISOString()).toBe('2026-03-10T00:00:00.000Z');
    });

    it('refuses a day further off, or something that is not a date', () => {
      expect(() => assignImportDate('2026-03-12', now)).toThrow(BadRequestException);
      expect(() => assignImportDate('2026-03-08', now)).toThrow(BadRequestException);
      expect(() => assignImportDate('03/10/2026', now)).toThrow(BadRequestException);
    });
  });

  describe('customKnownPrograms', () => {
    it('names each custom program, and asks only for this user', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { id: 'c1', name: 'My Split', specs: [{ week: 1, offset: 0, lift: 'Squat', wtDecrementPct: 0 }] },
      ]);
      const db = { customProgram: { findMany } } as unknown as PrismaExecutor;

      const programs = await customKnownPrograms(db, 'user-1');

      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1' } }));
      expect(programs).toEqual([expect.objectContaining({ id: 'c1', name: 'My Split' })]);
      const options = assignProgramOptions(programs);
      expect(options[options.length - 1]).toEqual({ id: 'c1', name: 'My Split', workouts: null, weeks: 1 });
    });

    it('has none with no database', async () => {
      expect(await customKnownPrograms(undefined, 'user-1')).toEqual([]);
    });
  });
});
