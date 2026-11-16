import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Prisma, PrismaClient } from '@prisma/client';
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

const tracer = trace.getTracer('prisma-training-data-repository');

/** Each cleared table's name in Postgres, from its model's `@@map`. */
const TABLE_NAMES: Record<TrainingTable, string> = {
  macrocycles: 'macrocycle',
  liftRecords: 'lift_record',
  macrocycleDashboards: 'macrocycle_dashboard',
  macrocycleScheduledWorkouts: 'macrocycle_scheduled_workout',
  trainingMaxes: 'training_max',
  trainingMaxHistory: 'training_max_history',
  liftModificationMaxes: 'lift_modification_max',
  workoutDateOverrides: 'workout_date_override',
  workoutSkipOverrides: 'workout_skip_override',
  workoutLiftOverrides: 'workout_lift_override',
  focusDayStates: 'focus_day_state',
  importBatches: 'import_batch',
};

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

  /**
   * `SELECT ... FOR UPDATE` on each table, which Prisma's client can't express. Raw SQL isn't
   * traced (ADR-024), hence the span. A write already holding a row lock is waited for, so what
   * `read` sees next is what `clear` deletes.
   */
  async lockRows(): Promise<TrainingDataCounts> {
    return tracer.startActiveSpan('training_data.lock_rows', async (span) => {
      try {
        const counts: Partial<TrainingDataCounts> = {};
        for (const table of TRAINING_TABLES) {
          const rows = await this.prisma.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM (
              SELECT 1 FROM ${Prisma.raw(`"${TABLE_NAMES[table]}"`)} WHERE "userId" = ${this.userId} FOR UPDATE
            ) locked`;
          counts[table] = rows[0]?.n ?? 0;
        }
        span.setAttribute('rows.locked', Object.values(counts).reduce((n, c) => n + (c ?? 0), 0));
        return counts as TrainingDataCounts;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async clear(): Promise<TrainingDataCounts> {
    const counts: Partial<TrainingDataCounts> = {};
    for (const table of [...TRAINING_TABLES].reverse()) {
      counts[table] = (await this.tables[table].deleteMany({ where: { userId: this.userId } })).count;
    }
    return counts as TrainingDataCounts;
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
