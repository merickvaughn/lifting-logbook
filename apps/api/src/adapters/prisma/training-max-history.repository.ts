import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { TrainingMaxHistoryEntry, liftSpellings } from '@lifting-logbook/core';
import { ITrainingMaxHistoryRepository, TrainingMaxHistoryFilters } from '../../ports/ITrainingMaxHistoryRepository';
import { HistoryEntryNotFoundError } from '../../ports/errors';

export class PrismaTrainingMaxHistoryRepository implements ITrainingMaxHistoryRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getHistory(program: string, filters?: TrainingMaxHistoryFilters): Promise<TrainingMaxHistoryEntry[]> {
    const rows = await this.prisma.trainingMaxHistory.findMany({
      where: {
        userId: this.userId,
        program,
        ...(filters?.lift !== undefined && { lift: { in: [...liftSpellings(filters.lift)] } }),
        ...(filters?.source !== undefined && { source: filters.source }),
        ...(filters?.isPR !== undefined && { isPR: filters.isPR }),
      },
      orderBy: { date: 'desc' },
    });
    // mirrors TrainingMaxHistory schema
    return rows.map((r: { id: string; lift: string; weight: number; reps: number; date: Date; isPR: boolean; source: string; goalMet: boolean }) => ({
      id: r.id,
      lift: r.lift,
      weight: r.weight,
      reps: r.reps,
      date: r.date,
      isPR: r.isPR,
      source: r.source as 'test' | 'program',
      goalMet: r.goalMet,
    }));
  }

  async appendHistoryEntries(
    program: string,
    entries: Omit<TrainingMaxHistoryEntry, 'id'>[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.prisma.trainingMaxHistory.createMany({
      data: entries.map((e) => ({
        userId: this.userId,
        program,
        lift: e.lift,
        weight: e.weight,
        reps: e.reps,
        date: e.date,
        isPR: e.isPR,
        source: e.source,
        goalMet: e.goalMet,
      })),
    });
  }

  async updateHistoryEntry(
    program: string,
    id: string,
    update: { isPR?: boolean; goalMet?: boolean },
  ): Promise<TrainingMaxHistoryEntry> {
    try {
      const row = await this.prisma.trainingMaxHistory.update({
        where: { id, userId: this.userId, program },
        data: {
          ...(update.isPR !== undefined && { isPR: update.isPR }),
          ...(update.goalMet !== undefined && { goalMet: update.goalMet }),
        },
      });
      return {
        id: row.id,
        lift: row.lift,
        weight: row.weight,
        reps: row.reps,
        date: row.date,
        isPR: row.isPR,
        source: row.source as 'test' | 'program',
        goalMet: row.goalMet,
      };
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new HistoryEntryNotFoundError(id);
      }
      throw e;
    }
  }

  async deleteAllHistory(program: string): Promise<void> {
    await this.prisma.trainingMaxHistory.deleteMany({
      where: { userId: this.userId, program },
    });
  }
}
