import { ImportPreImage } from '@lifting-logbook/core';
import { ImportKind } from '@lifting-logbook/types';
import {
  IImportBatchRepository,
  ImportBatchRecord,
  KeyNumbers,
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
}
