import { PrismaClient } from '@prisma/client';
import { TrainingMax, classifyAndCount, latestTrainingMaxFirst, trainingMaxRowKind } from '@lifting-logbook/core';
import { ImportWriteResult } from '@lifting-logbook/types';
import { ITrainingMaxRepository } from '../../ports/ITrainingMaxRepository';
import { IMPORT_BATCH_TX_OPTIONS, runBatch, runInteractive } from './prisma-tx.util';

export class PrismaTrainingMaxRepository implements ITrainingMaxRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getTrainingMaxes(program: string): Promise<TrainingMax[]> {
    const rows = await this.prisma.trainingMax.findMany({
      where: { userId: this.userId, program },
    });
    // mirrors TrainingMax schema
    return rows.map((r: { lift: string; weight: number; dateUpdated: Date }) => ({
      lift: r.lift,
      weight: r.weight,
      dateUpdated: r.dateUpdated,
    }));
  }

  async saveTrainingMaxes(program: string, maxes: TrainingMax[]): Promise<void> {
    await runBatch(this.prisma, (db) =>
      maxes.map((m) =>
        db.trainingMax.upsert({
          where: {
            userId_program_lift: { userId: this.userId, program, lift: m.lift },
          },
          create: {
            userId: this.userId,
            program,
            lift: m.lift,
            weight: m.weight,
            dateUpdated: m.dateUpdated,
          },
          update: {
            weight: m.weight,
            dateUpdated: m.dateUpdated,
          },
        }),
      ),
    );
  }

  async importTrainingMaxes(
    program: string,
    maxes: TrainingMax[],
  ): Promise<ImportWriteResult> {
    // One transaction for the whole batch: the existing read and every upsert
    // share it, so the returned counts reflect exactly what was written and a
    // mid-batch failure rolls the whole import back (issue #488). runInteractive
    // reuses the per-request RLS transaction when present, opens one otherwise
    // (with a batch-sized timeout — see IMPORT_BATCH_TX_OPTIONS, #532).
    return runInteractive(
      this.prisma,
      async (tx) => {
        const existing = await tx.trainingMax.findMany({
          where: { userId: this.userId, program },
          select: { lift: true, weight: true },
        });
        const existingByLift = new Map(existing.map((r) => [r.lift, r.weight]));

        // Shared classify/dedupe/tally loop (#532) so every adapter reports counts
        // identically; the create/update/skip decision is trainingMaxRowKind.
        return classifyAndCount(
          latestTrainingMaxFirst(maxes),
          (m) => m.lift,
          (m) => trainingMaxRowKind(m, existingByLift),
          (m) =>
            tx.trainingMax.upsert({
              where: {
                userId_program_lift: { userId: this.userId, program, lift: m.lift },
              },
              create: {
                userId: this.userId,
                program,
                lift: m.lift,
                weight: m.weight,
                dateUpdated: m.dateUpdated,
              },
              update: { weight: m.weight, dateUpdated: m.dateUpdated },
            }),
        );
      },
      IMPORT_BATCH_TX_OPTIONS,
    );
  }

  async deleteTrainingMaxes(program: string, lifts: string[]): Promise<void> {
    if (lifts.length === 0) return;
    await this.prisma.trainingMax.deleteMany({
      where: { userId: this.userId, program, lift: { in: lifts } },
    });
  }

  async deleteAllTrainingMaxes(program: string): Promise<void> {
    await this.prisma.trainingMax.deleteMany({
      where: { userId: this.userId, program },
    });
  }

  async getMissingMaxDismissals(program: string): Promise<string[]> {
    const rows = await this.prisma.missingMaxDismissal.findMany({
      where: { userId: this.userId, program },
      select: { liftId: true },
    });
    return rows.map((r) => r.liftId);
  }

  async dismissMissingMax(program: string, liftId: string): Promise<void> {
    // `createMany` with `skipDuplicates` is an INSERT … ON CONFLICT DO NOTHING: idempotent, and it
    // can't abort the request's RLS transaction on a duplicate the way a failed `create` would.
    await this.prisma.missingMaxDismissal.createMany({
      data: [{ userId: this.userId, program, liftId }],
      skipDuplicates: true,
    });
  }

  async undismissMissingMax(program: string, liftId: string): Promise<void> {
    await this.prisma.missingMaxDismissal.deleteMany({ where: { userId: this.userId, program, liftId } });
  }
}
