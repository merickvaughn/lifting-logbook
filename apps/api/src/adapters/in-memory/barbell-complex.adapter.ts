import { randomUUID } from 'crypto';
import { BarbellComplex } from '@lifting-logbook/types';
import {
  CreateBarbellComplexInput,
  IBarbellComplexRepository,
  UpdateBarbellComplexPatch,
} from '../../ports/IBarbellComplexRepository';
import { BarbellComplexConflictError, BarbellComplexNotFoundError } from '../../ports/errors';

export class InMemoryBarbellComplexRepository implements IBarbellComplexRepository {
  private readonly store = new Map<string, BarbellComplex>();

  constructor(private readonly userId: string) {}

  async list(): Promise<BarbellComplex[]> {
    return [...this.store.values()].sort((a, b) => a.name.localeCompare(b.name)).map(copy);
  }

  async create(input: CreateBarbellComplexInput): Promise<BarbellComplex> {
    this.assertNameFree(input.name);
    const complex: BarbellComplex = {
      id: randomUUID(),
      userId: this.userId,
      name: input.name,
      components: input.components.map((c) => ({ ...c })),
      createdAt: new Date(),
    };
    this.store.set(complex.id, complex);
    return copy(complex);
  }

  async update(id: string, patch: UpdateBarbellComplexPatch): Promise<BarbellComplex> {
    const existing = this.store.get(id);
    if (!existing) throw new BarbellComplexNotFoundError(id);
    if (patch.name !== undefined) this.assertNameFree(patch.name, id);
    const updated: BarbellComplex = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.components !== undefined ? { components: patch.components.map((c) => ({ ...c })) } : {}),
    };
    this.store.set(id, updated);
    return copy(updated);
  }

  async delete(id: string): Promise<void> {
    if (!this.store.delete(id)) throw new BarbellComplexNotFoundError(id);
  }

  private assertNameFree(name: string, exceptId?: string): void {
    const taken = [...this.store.values()].some((c) => c.name === name && c.id !== exceptId);
    if (taken) throw new BarbellComplexConflictError(name);
  }
}

function copy(complex: BarbellComplex): BarbellComplex {
  return { ...complex, components: complex.components.map((c) => ({ ...c })) };
}
