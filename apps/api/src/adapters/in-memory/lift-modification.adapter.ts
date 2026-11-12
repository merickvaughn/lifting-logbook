import { randomUUID } from 'crypto';
import { LiftRecord, ModificationMax } from '@lifting-logbook/core';
import { LiftModification } from '@lifting-logbook/types';
import {
  CreateLiftModificationInput,
  ILiftModificationRepository,
  UpdateLiftModificationPatch,
} from '../../ports/ILiftModificationRepository';
import { LiftModificationConflictError, LiftModificationNotFoundError } from '../../ports/errors';

export class InMemoryLiftModificationRepository implements ILiftModificationRepository {
  private readonly store = new Map<string, LiftModification>();
  private readonly maxesByProgram = new Map<string, Map<string, ModificationMax>>();

  /** `records` is the store the user's lift record repository writes, for the delete rule. */
  constructor(
    private readonly userId: string,
    private readonly records: ReadonlyMap<string, LiftRecord[]>,
  ) {}

  async list(): Promise<LiftModification[]> {
    return Array.from(this.store.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(input: CreateLiftModificationInput): Promise<LiftModification> {
    const taken = this.findByName(input.lift, input.name);
    if (taken && !taken.archivedAt) throw new LiftModificationConflictError(input.name);
    const modification: LiftModification = {
      ...(taken ?? {
        id: randomUUID(),
        userId: this.userId,
        lift: input.lift,
        name: input.name,
        createdAt: new Date(),
      }),
      description: input.description ?? '',
      maxMode: input.maxMode ?? 'none',
      archivedAt: null,
    };
    this.store.set(modification.id, modification);
    return modification;
  }

  async update(id: string, patch: UpdateLiftModificationPatch): Promise<LiftModification> {
    const existing = this.store.get(id);
    if (!existing || existing.archivedAt) throw new LiftModificationNotFoundError(id);
    if (patch.name !== undefined) {
      const taken = this.findByName(existing.lift, patch.name);
      if (taken && taken.id !== id) throw new LiftModificationConflictError(patch.name);
    }
    const updated: LiftModification = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.maxMode !== undefined ? { maxMode: patch.maxMode } : {}),
    };
    this.store.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) throw new LiftModificationNotFoundError(id);
    const namedBySet = [...this.records.values()].flat().some((r) => r.modifications?.includes(id));
    if (!namedBySet) {
      this.store.delete(id);
      // The Prisma foreign key cascades.
      for (const maxes of this.maxesByProgram.values()) maxes.delete(id);
    } else if (!existing.archivedAt) {
      this.store.set(id, { ...existing, archivedAt: new Date() });
    }
  }

  async getMaxes(program: string): Promise<ModificationMax[]> {
    return [...(this.maxesByProgram.get(program)?.values() ?? [])]
      .sort((a, b) => a.modificationId.localeCompare(b.modificationId))
      .map((m) => ({ ...m }));
  }

  async saveMaxes(program: string, maxes: readonly ModificationMax[]): Promise<void> {
    const byId = this.maxesByProgram.get(program) ?? new Map<string, ModificationMax>();
    for (const m of maxes) byId.set(m.modificationId, { ...m });
    this.maxesByProgram.set(program, byId);
  }

  async deleteAllMaxes(program: string): Promise<void> {
    this.maxesByProgram.delete(program);
  }

  private findByName(lift: string, name: string): LiftModification | undefined {
    return [...this.store.values()].find((m) => m.lift === lift && m.name === name);
  }
}
