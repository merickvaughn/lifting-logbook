import { ImportPreImage } from '@lifting-logbook/core';
import { ImportKind } from '@lifting-logbook/types';
import {
  BatchMacrocycles,
  IImportBatchRepository,
  ImportBatchRecord,
  ImportBatchSummaryRecord,
  KeyNumbers,
  createdNumberedKeys,
  preImageKeyNumber,
} from '../../ports/IImportBatchRepository';

export class InMemoryImportBatchRepository implements IImportBatchRepository {
  private readonly store = new Map<string, ImportBatchRecord>();

  async save(batch: ImportBatchRecord): Promise<void> {
    this.store.set(batch.id, batch);
  }

  async findById(id: string, userId: string): Promise<ImportBatchRecord | null> {
    const record = this.store.get(id);
    if (!record || record.userId !== userId) return null;
    return record;
  }

  async listGroup(groupId: string): Promise<ImportBatchRecord[]> {
    return [...this.store.values()].filter((b) => b.groupId === groupId);
  }

  async listSummaries(program: string, destination: ImportKind): Promise<ImportBatchSummaryRecord[]> {
    return [...this.store.values()]
      .filter((b) => b.program === program && b.destination === destination)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map((b) => {
        const head = b.groupId ? this.store.get(b.groupId) : undefined;
        return {
          id: b.id,
          program: b.program,
          createdAt: b.createdAt,
          source: head ? { id: head.id, program: head.program, createdAt: head.createdAt } : null,
          macrocycles: b.macrocycles,
          createdNums: [...new Set(createdNumberedKeys(b.preImage).flatMap((k) => preImageKeyNumber(k) ?? []))],
        };
      });
  }

  async deleteById(id: string, userId: string): Promise<void> {
    const record = this.store.get(id);
    if (record && record.userId === userId) this.store.delete(id);
  }

  // The bundle is one user's, so every stored batch is theirs.
  async listWithKeysOn(program: string, destination: ImportKind, which: KeyNumbers): Promise<ImportBatchRecord[]> {
    const matches = (n: number) => ('on' in which ? which.on.includes(n) : !which.except.includes(n));
    return [...this.store.values()].filter(
      (b) =>
        b.program === program &&
        b.destination === destination &&
        Object.keys(b.preImage).some((key) => {
          const num = preImageKeyNumber(key);
          return num !== null && matches(num);
        }),
    );
  }

  async listWithKeys(destination: ImportKind, keys: readonly string[]): Promise<ImportBatchRecord[]> {
    return [...this.store.values()].filter(
      (b) => b.destination === destination && keys.some((key) => key in b.preImage),
    );
  }

  async updatePreImages(updates: ReadonlyArray<{ id: string; preImage: ImportPreImage }>): Promise<void> {
    for (const { id, preImage } of updates) {
      const record = this.store.get(id);
      if (record) this.store.set(id, { ...record, preImage });
    }
  }

  async listChoosing(macrocycleId: string): Promise<ImportBatchRecord[]> {
    return [...this.store.values()].filter((b) => b.macrocycles?.chosen.some((c) => c.id === macrocycleId));
  }

  async updateMacrocycles(id: string, macrocycles: BatchMacrocycles): Promise<void> {
    const record = this.store.get(id);
    if (record) this.store.set(id, { ...record, macrocycles });
  }
}
