import { TrainingDataCounts } from '@lifting-logbook/types';
import {
  ITrainingDataRepository,
  TRAINING_TABLES,
  TrainingData,
  TrainingRow,
  TrainingTable,
} from '../../ports/ITrainingDataRepository';

/**
 * An in-memory store holding one of Clear data's tables (#1309). Rows follow the port's
 * {@link TrainingRow} contract: `program`, plus `macrocycleNum` and `workoutNum` where the table
 * has them, which a restore may change before handing the rows back.
 */
export interface TrainingStore {
  readonly trainingTable: TrainingTable;
  trainingRows(): TrainingRow[];
  clearTraining(): void;
  /** Adds the rows whose key no stored row holds, and returns how many it added. */
  restoreTraining(rows: readonly TrainingRow[]): number;
}

/** Every store in a repository bundle that holds a cleared table. */
export function trainingStoresIn(bundle: object): TrainingStore[] {
  return Object.values(bundle).filter(
    (repo): repo is TrainingStore => typeof repo === 'object' && repo !== null && 'trainingTable' in repo,
  );
}

/** A number-bearing row field, which every numbered table's rows carry. */
export function numberOf(row: TrainingRow, field: 'macrocycleNum' | 'workoutNum'): number {
  const value = row[field];
  if (typeof value !== 'number') throw new Error(`a training row has no ${field}`);
  return value;
}

export class InMemoryTrainingDataRepository implements ITrainingDataRepository {
  private stores: readonly TrainingStore[] = [];

  /** Wires in the bundle's stores; the factories pass `trainingStoresIn(bundle)`. */
  attach(stores: readonly TrainingStore[]): void {
    this.stores = stores;
  }

  private store(table: TrainingTable): TrainingStore | undefined {
    return this.stores.find((s) => s.trainingTable === table);
  }

  async read(): Promise<TrainingData> {
    const data = Object.fromEntries(
      TRAINING_TABLES.map((table) => [table, structuredClone(this.store(table)?.trainingRows() ?? [])]),
    );
    return data as TrainingData;
  }

  async counts(): Promise<TrainingDataCounts> {
    const counts = Object.fromEntries(TRAINING_TABLES.map((table) => [table, this.store(table)?.trainingRows().length ?? 0]));
    return counts as unknown as TrainingDataCounts;
  }

  /** One request runs at a time here, so there is nothing to lock. */
  async lockRows(): Promise<TrainingDataCounts> {
    return this.counts();
  }

  async clear(): Promise<TrainingDataCounts> {
    const counts = await this.counts();
    for (const store of this.stores) store.clearTraining();
    return counts;
  }

  async insertMissing(data: TrainingData): Promise<TrainingDataCounts> {
    const counts = Object.fromEntries(
      TRAINING_TABLES.map((table) => [table, this.store(table)?.restoreTraining(structuredClone(data[table])) ?? 0]),
    );
    return counts as unknown as TrainingDataCounts;
  }
}
