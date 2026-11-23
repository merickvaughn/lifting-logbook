import { DEFAULT_FOCUS_BUDGET, FocusBlock, FocusBudget, FocusDayState, StoredFocusBlock } from '@lifting-logbook/types';
import { FocusBlockPatch, IFocusRepository } from '../../ports/IFocusRepository';
import { FocusBlockConflictError, FocusBlockNotFoundError } from '../../ports/errors';
import { TrainingRow } from '../../ports/ITrainingDataRepository';
import { NumberedStore, dropFromMap, numbersInMap, rekeyMap } from './renumber';
import { TrainingStore, numberOf } from './training-data.adapter';

function dayKeyNumber(key: string): { program: string; macrocycleNum: number } {
  const [program, macrocycleNum] = JSON.parse(key) as [string, number, number];
  return { program, macrocycleNum };
}

/** Mirrors PrismaFocusRepository, including its (series, start) uniqueness. */
export class InMemoryFocusRepository implements IFocusRepository, NumberedStore, TrainingStore {
  private readonly blocks = new Map<string, StoredFocusBlock>();
  private readonly dayStates = new Map<string, FocusDayState>();
  private budget: FocusBudget = { ...DEFAULT_FOCUS_BUDGET };

  /** Day states are training data; focus blocks are setup, which Clear data keeps (decision 20). */
  readonly trainingTable = 'focusDayStates';

  trainingRows(): TrainingRow[] {
    return [...this.dayStates].map(([key, state]) => {
      const [program, macrocycleNum, workoutNum] = JSON.parse(key) as [string, number, number];
      return { program, macrocycleNum, workoutNum, state };
    });
  }

  clearTraining(): void {
    this.dayStates.clear();
  }

  restoreTraining(rows: readonly TrainingRow[]): number {
    let added = 0;
    for (const row of rows) {
      const key = dayKey(row.program, numberOf(row, 'macrocycleNum'), numberOf(row, 'workoutNum'));
      if (this.dayStates.has(key)) continue;
      this.dayStates.set(key, row.state as FocusDayState);
      added++;
    }
    return added;
  }

  rewriteNumbers(program: string, changes: ReadonlyMap<number, number>): number {
    return rekeyMap(this.dayStates, program, changes, dayKeyNumber, (key, macrocycleNum) => {
      const [p, , workoutNum] = JSON.parse(key) as [string, number, number];
      return dayKey(p, macrocycleNum, workoutNum);
    });
  }

  readonly table = 'focus_day_state';

  numbersHeld(program: string): Set<number> {
    return numbersInMap(this.dayStates, program, dayKeyNumber);
  }

  dropNumbers(program: string, macrocycleNums: readonly number[]): void {
    dropFromMap(this.dayStates, program, macrocycleNums, dayKeyNumber);
  }

  async listBlocks(): Promise<StoredFocusBlock[]> {
    // Insertion order breaks ties, as createdAt does in the Prisma adapter.
    return [...this.blocks.values()]
      .sort((a, b) => a.priority - b.priority || a.start.localeCompare(b.start))
      .map(clone);
  }

  async getBlock(id: string): Promise<StoredFocusBlock | null> {
    const block = this.blocks.get(id);
    return block ? clone(block) : null;
  }

  /** The in-memory store has no concurrent writers to lock out, so this only reads. */
  async lockBlocks(ids: readonly string[]): Promise<StoredFocusBlock[]> {
    return [...new Set(ids)]
      .sort()
      .flatMap((id) => {
        const block = this.blocks.get(id);
        return block ? [clone(block)] : [];
      });
  }

  async createBlock(block: FocusBlock): Promise<StoredFocusBlock> {
    if (this.startTaken(block.series, block.start)) {
      throw new FocusBlockConflictError(block.series, block.start);
    }
    const stored = firstVersion(block);
    this.blocks.set(block.id, stored);
    return clone(stored);
  }

  async createBlocksIfAbsent(blocks: readonly FocusBlock[]): Promise<void> {
    for (const block of blocks) {
      if (!this.startTaken(block.series, block.start)) this.blocks.set(block.id, firstVersion(block));
    }
  }

  async updateBlock(id: string, patch: FocusBlockPatch): Promise<StoredFocusBlock> {
    const existing = this.blocks.get(id);
    if (!existing) throw new FocusBlockNotFoundError(id);
    if (patch.start !== undefined && this.startTaken(existing.series, patch.start, id)) {
      throw new FocusBlockConflictError(existing.series, patch.start);
    }
    const updated: StoredFocusBlock = { ...existing, ...patch, version: existing.version + 1 };
    this.blocks.set(id, clone(updated));
    return clone(updated);
  }

  async deleteBlock(id: string): Promise<void> {
    if (!this.blocks.delete(id)) throw new FocusBlockNotFoundError(id);
  }

  async setPriorities(priorities: readonly { id: string; priority: number }[]): Promise<void> {
    for (const { id, priority } of priorities) {
      const block = this.blocks.get(id);
      if (block) this.blocks.set(id, { ...block, priority });
    }
  }

  async getBudget(): Promise<FocusBudget> {
    return { ...this.budget };
  }

  async setBudget(budget: FocusBudget): Promise<FocusBudget> {
    this.budget = { ...budget };
    return { ...this.budget };
  }

  async getDayState(program: string, macrocycleNum: number, workoutNum: number): Promise<FocusDayState | null> {
    const state = this.dayStates.get(dayKey(program, macrocycleNum, workoutNum));
    return state ? structuredClone(state) : null;
  }

  async getDayStatesForMacrocycle(program: string, macrocycleNum: number): Promise<Map<number, FocusDayState>> {
    const states = new Map<number, FocusDayState>();
    for (const [key, state] of this.dayStates) {
      const [p, m, workoutNum] = JSON.parse(key) as [string, number, number];
      if (p === program && m === macrocycleNum) states.set(workoutNum, structuredClone(state));
    }
    return states;
  }

  async saveDayState(
    program: string,
    macrocycleNum: number,
    workoutNum: number,
    state: FocusDayState,
  ): Promise<FocusDayState> {
    this.dayStates.set(dayKey(program, macrocycleNum, workoutNum), structuredClone(state));
    return structuredClone(state);
  }

  private startTaken(series: string, start: string, exceptId?: string): boolean {
    for (const block of this.blocks.values()) {
      if (block.series === series && block.start === start && block.id !== exceptId) return true;
    }
    return false;
  }
}

// Copies keep callers from mutating stored state, as a database round trip would.
function clone<B extends FocusBlock>(block: B): B {
  return structuredClone(block);
}

/** A new block as stored, at version 1 whatever version a copied block carried. */
function firstVersion(block: FocusBlock): StoredFocusBlock {
  return { ...structuredClone(block), version: 1 };
}

function dayKey(program: string, macrocycleNum: number, workoutNum: number): string {
  return JSON.stringify([program, macrocycleNum, workoutNum]);
}
