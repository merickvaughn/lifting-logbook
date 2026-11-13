import { BadRequestException } from '@nestjs/common';
import type { TrainingMax } from '@lifting-logbook/core';
import type { PrismaExecutor } from '../adapters/prisma/prisma-tx.util';
import { CustomProgramsRepository } from '../custom-programs/custom-programs.repository';
import type { RepositoryBundle } from '../ports/factory';
import { assignImportDate, assignProgramOptions, importAssignEnabled, splitMaxCounts } from './import-assign';

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

  describe('CustomProgramsRepository.listKnownPrograms', () => {
    it('names each custom program, asks only for this user, and reads in a fixed order', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { id: 'c1', name: 'My Split', specs: [{ week: 1, offset: 0, lift: 'Squat', wtDecrementPct: 0 }] },
      ]);
      const db = { customProgram: { findMany } } as unknown as PrismaExecutor;

      const programs = await new CustomProgramsRepository(db, 'user-1').listKnownPrograms();

      const query = findMany.mock.calls[0]?.[0];
      expect(query.where).toEqual({ userId: 'user-1' });
      expect(query.orderBy).toEqual({ createdAt: 'desc' });
      expect(query.select.specs.orderBy).toEqual([{ week: 'asc' }, { order: 'asc' }]);
      expect(programs).toEqual([expect.objectContaining({ id: 'c1', name: 'My Split' })]);
      const options = assignProgramOptions(programs);
      expect(options[options.length - 1]).toEqual({ id: 'c1', name: 'My Split', workouts: null, weeks: 1 });
    });
  });

  describe('splitMaxCounts', () => {
    const max = (lift: string, day: number, weight: number) => ({
      lift,
      weight,
      dateUpdated: new Date(Date.UTC(2026, 0, day)),
    });
    // 5-3-1 covers January 1 to 15, rpt January 16 to 31.
    const stretches = [
      { program: '5-3-1', startDate: new Date(Date.UTC(2026, 0, 1)), endDate: new Date(Date.UTC(2026, 0, 15)) },
      { program: 'rpt', startDate: new Date(Date.UTC(2026, 0, 16)), endDate: new Date(Date.UTC(2026, 0, 31)) },
    ];

    it("judges each program's newest row, though another program holds the lift's newest overall", async () => {
      // 5-3-1's stored Squat max is dated January 8: its January 5 row is older, its January 10 row isn't.
      const stored: Record<string, TrainingMax[]> = { '5-3-1': [max('Squat', 8, 300)], rpt: [] };
      const repos = { trainingMax: { getTrainingMaxes: async (p: string) => stored[p] ?? [] } };

      const counts = await splitMaxCounts(
        [max('Squat', 20, 330), max('Squat', 5, 310), max('Squat', 10, 320)],
        stretches,
        'rpt',
        repos as unknown as Pick<RepositoryBundle, 'trainingMax'>,
      );

      // rpt's January 20 row has no stored max to match, and 5-3-1's January 10 row changes its max.
      expect(counts).toEqual({ changes: 2, olderThanCurrent: 0 });
    });
  });
});
