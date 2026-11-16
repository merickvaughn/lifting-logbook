import { PrismaClient } from '@prisma/client';
import { TrainingDataCounts } from '@lifting-logbook/types';
import {
  ITrainingDataRepository,
  TRAINING_TABLES,
  TrainingData,
  TrainingRow,
  TrainingTable,
} from '../../ports/ITrainingDataRepository';

/**
 * The part of a Prisma model delegate this adapter uses. Every cleared table has a `userId`
 * column and no relation the rows here need, so one shape covers them all. `createMany` takes
 * `never[]` because each table wants its own input type: the rows are the ones `findMany` read,
 * with the user id put back, so they match their table's columns.
 */
interface TableDelegate {
  findMany(args: { where: { userId: string } }): Promise<Record<string, unknown>[]>;
  count(args: { where: { userId: string } }): Promise<number>;
  deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
  createMany(args: { data: never[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
}

function delegates(db: PrismaClient): Record<TrainingTable, TableDelegate> {
  return {
    macrocycles: db.macrocycle,
    liftRecords: db.liftRecord,
    macrocycleDashboards: db.macrocycleDashboard,
    macrocycleScheduledWorkouts: db.macrocycleScheduledWorkout,
    trainingMaxes: db.trainingMax,
    trainingMaxHistory: db.trainingMaxHistory,
    liftModificationMaxes: db.liftModificationMax,
    workoutDateOverrides: db.workoutDateOverride,
    workoutSkipOverrides: db.workoutSkipOverride,
    workoutLiftOverrides: db.workoutLiftOverride,
    focusDayStates: db.focusDayState,
    importBatches: db.importBatch,
  };
}

/**
 * A row as `createMany` takes it: with the user id, and without a null `import_batch.macrocycles`,
 * which Prisma won't take as a plain `null` for a JSON column. Left out, it defaults to null.
 */
function insertable(row: TrainingRow, userId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row, userId };
  if (out.macrocycles === null) delete out.macrocycles;
  return out;
}

/**
 * Clear data's tables in Postgres (#1309, proposal decision 20). One query at a time: they share
 * the request transaction's connection, which the caller opens with the user's RLS context.
 */
export class PrismaTrainingDataRepository implements ITrainingDataRepository {
  private readonly tables: Record<TrainingTable, TableDelegate>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {
    this.tables = delegates(prisma);
  }

  async read(): Promise<TrainingData> {
    const data: Partial<Record<TrainingTable, TrainingRow[]>> = {};
    for (const table of TRAINING_TABLES) {
      const rows = await this.tables[table].findMany({ where: { userId: this.userId } });
      data[table] = rows.map(({ userId: _userId, ...row }) => row as TrainingRow);
    }
    return data as TrainingData;
  }

  async counts(): Promise<TrainingDataCounts> {
    const counts: Partial<TrainingDataCounts> = {};
    for (const table of TRAINING_TABLES) counts[table] = await this.tables[table].count({ where: { userId: this.userId } });
    return counts as TrainingDataCounts;
  }

  async clear(): Promise<void> {
    for (const table of [...TRAINING_TABLES].reverse()) {
      await this.tables[table].deleteMany({ where: { userId: this.userId } });
    }
  }

  async insertMissing(data: TrainingData): Promise<TrainingDataCounts> {
    // A modification's own max references the modification, which the lifter may have deleted
    // since the clear; inserting one for a deleted modification would fail the whole statement.
    const modifications = new Set(
      (await this.prisma.liftModification.findMany({ where: { userId: this.userId }, select: { id: true } })).map((m) => m.id),
    );
    const counts: Partial<TrainingDataCounts> = {};
    for (const table of TRAINING_TABLES) {
      let rows = data[table];
      if (table === 'liftModificationMaxes') rows = rows.filter((r) => modifications.has(String(r.modificationId)));
      counts[table] =
        rows.length === 0
          ? 0
          : (
              await this.tables[table].createMany({
                data: rows.map((r) => insertable(r, this.userId)) as never[],
                skipDuplicates: true,
              })
            ).count;
    }
    return counts as TrainingDataCounts;
  }
}
