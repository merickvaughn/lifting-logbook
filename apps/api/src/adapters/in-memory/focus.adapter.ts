import { DEFAULT_FOCUS_BUDGET, FocusBlock, FocusBudget, FocusDayState } from '@lifting-logbook/types';
import { FocusBlockPatch, IFocusRepository } from '../../ports/IFocusRepository';
import { FocusBlockConflictError, FocusBlockNotFoundError } from '../../ports/errors';

/** Mirrors PrismaFocusRepository, including its (series, start) uniqueness. */
export class InMemoryFocusRepository implements IFocusRepository {
  private readonly blocks = new Map<string, FocusBlock>();
  private readonly dayStates = new Map<string, FocusDayState>();
  private budget: FocusBudget = { ...DEFAULT_FOCUS_BUDGET };

  async listBlocks(): Promise<FocusBlock[]> {
    // Insertion order breaks ties, as createdAt does in the Prisma adapter.
    return [...this.blocks.values()]
      .sort((a, b) => a.priority - b.priority || a.start.localeCompare(b.start))
      .map(clone);
  }

  async getBlock(id: string): Promise<FocusBlock | null> {
    const block = this.blocks.get(id);
    return block ? clone(block) : null;
  }

  async createBlock(block: FocusBlock): Promise<FocusBlock> {
    if (this.startTaken(block.series, block.start)) {
      throw new FocusBlockConflictError(block.series, block.start);
    }
    this.blocks.set(block.id, clone(block));
    return clone(block);
  }

  async createBlocksIfAbsent(blocks: readonly FocusBlock[]): Promise<void> {
    for (const block of blocks) {
      if (!this.startTaken(block.series, block.start)) this.blocks.set(block.id, clone(block));
    }
  }

  async updateBlock(id: string, patch: FocusBlockPatch): Promise<FocusBlock> {
    const existing = this.blocks.get(id);
    if (!existing) throw new FocusBlockNotFoundError(id);
    if (patch.start !== undefined && this.startTaken(existing.series, patch.start, id)) {
      throw new FocusBlockConflictError(existing.series, patch.start);
    }
    const updated: FocusBlock = { ...existing, ...patch };
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
function clone(block: FocusBlock): FocusBlock {
  return structuredClone(block);
}

function dayKey(program: string, macrocycleNum: number, workoutNum: number): string {
  return JSON.stringify([program, macrocycleNum, workoutNum]);
}
