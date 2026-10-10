import { PrismaClient } from '@prisma/client';
import { IMacrocycleScheduledWorkoutRepository, ScheduledWorkout } from '../../ports/IMacrocycleScheduledWorkoutRepository';
import { runBatch } from './prisma-tx.util';

export class PrismaMacrocycleScheduledWorkoutRepository implements IMacrocycleScheduledWorkoutRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getScheduledWorkouts(program: string, macrocycleNum: number): Promise<ScheduledWorkout[]> {
    const rows = await this.prisma.macrocycleScheduledWorkout.findMany({
      where: { userId: this.userId, program, macrocycleNum },
      orderBy: { workoutNum: 'asc' },
    });
    return rows.map((r) => ({
      workoutNum: r.workoutNum,
      weekNum: r.weekNum,
      scheduledDate: r.scheduledDate,
    }));
  }

  async saveScheduledWorkouts(program: string, macrocycleNum: number, workouts: ScheduledWorkout[]): Promise<void> {
    // deleteMany + createMany replaces the full row set for (userId, program, macrocycleNum).
    // Concurrent macrocycle creation (e.g., double-submit) can race and hit the unique constraint.
    // Acceptable given macrocycle creation is a rare, deliberate user action; harden with
    // upsert-per-row semantics if this surfaces in practice.
    await runBatch(this.prisma, (db) => [
      db.macrocycleScheduledWorkout.deleteMany({
        where: { userId: this.userId, program, macrocycleNum },
      }),
      db.macrocycleScheduledWorkout.createMany({
        data: workouts.map((w) => ({
          userId: this.userId,
          program,
          macrocycleNum,
          workoutNum: w.workoutNum,
          weekNum: w.weekNum,
          scheduledDate: w.scheduledDate,
        })),
      }),
    ]);
  }
}
