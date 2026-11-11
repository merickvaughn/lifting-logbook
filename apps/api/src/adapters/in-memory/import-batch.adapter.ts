import { ImportPreImage } from '@lifting-logbook/core';
import { ImportKind } from '@lifting-logbook/types';
import { IImportBatchRepository, ImportBatchRecord } from '../../ports/IImportBatchRepository';

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
  async listForProgram(program: string, destination: ImportKind): Promise<ImportBatchRecord[]> {
    return [...this.store.values()].filter((b) => b.program === program && b.destination === destination);
  }

  async listWithKeysOn(program: string, destination: ImportKind, macrocycleNums: readonly number[]): Promise<ImportBatchRecord[]> {
    return (await this.listForProgram(program, destination)).filter((b) =>
      Object.keys(b.preImage).some((key) => {
        const num = /^(?:macrocycle-row:)?(\d+)(?::|$)/.exec(key)?.[1];
        return num !== undefined && macrocycleNums.includes(Number(num));
      }),
    );
  }

  async updatePreImage(id: string, preImage: ImportPreImage): Promise<void> {
    const record = this.store.get(id);
    if (record) this.store.set(id, { ...record, preImage });
  }
}
