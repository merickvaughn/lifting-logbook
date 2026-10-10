import { PrismaClient } from '@prisma/client';
import { LiftRecord } from '@lifting-logbook/core';
import { IWorkoutRepository } from '../../ports/IWorkoutRepository';
import { WorkoutNotFoundError } from '../../ports/errors';
import { rowToLiftRecord } from './lift-record.repository';
import { runBatch } from './prisma-tx.util';

export class PrismaWorkoutRepository implements IWorkoutRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getWorkout(program: string, macrocycleNum: number, workoutNum: number): Promise<LiftRecord[]> {
    const rows = await this.prisma.liftRecord.findMany({
      where: { userId: this.userId, program, macrocycleNum, workoutNum },
      orderBy: [{ lift: 'asc' }, { setNum: 'asc' }],
    });
    if (rows.length === 0) throw new WorkoutNotFoundError(program, macrocycleNum, workoutNum);
    return rows.map(rowToLiftRecord);
  }

  async saveWorkout(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    records: LiftRecord[],
  ): Promise<void> {
    await runBatch(this.prisma, (db) => [
      db.liftRecord.deleteMany({
        where: { userId: this.userId, program, macrocycleNum, workoutNum },
      }),
      db.liftRecord.createMany({
        data: records.map((r) => ({
          userId: this.userId,
          program,
          macrocycleNum,
          workoutNum,
          date: r.date,
          lift: r.lift,
          setNum: r.setNum,
          weight: r.weight,
          reps: r.reps,
          notes: r.notes,
        })),
      }),
    ]);
  }
}
