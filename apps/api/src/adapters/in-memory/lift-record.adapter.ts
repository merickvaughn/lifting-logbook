import { LiftRecord, buildLiftRecordId, liftRecordNaturalKey } from '@lifting-logbook/core';
import { ILiftRecordRepository } from '../../ports/ILiftRecordRepository';

export class InMemoryLiftRecordRepository implements ILiftRecordRepository {
  constructor(private readonly store: Map<string, LiftRecord[]>) {}

  async getLiftRecords(program: string, cycleNum: number): Promise<LiftRecord[]> {
    return (this.store.get(program) ?? []).filter((r) => r.cycleNum === cycleNum);
  }

  async getLoggedWorkoutNums(program: string, cycleNum: number): Promise<Set<number>> {
    return new Set(
      (this.store.get(program) ?? [])
        .filter((r) => r.cycleNum === cycleNum)
        .map((r) => r.workoutNum),
    );
  }

  async appendLiftRecords(program: string, records: LiftRecord[]): Promise<number> {
    // Mirror Prisma's createMany({ skipDuplicates: true }) on the natural-key
    // unique constraint: rows whose key already exists (or repeats within this
    // batch) are skipped, and the return value is the count actually inserted.
    const existing = this.store.get(program) ?? [];
    const seenKeys = new Set(existing.map(liftRecordNaturalKey));
    const toInsert: LiftRecord[] = [];
    for (const r of records) {
      const key = liftRecordNaturalKey(r);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      toInsert.push(r);
    }
    this.store.set(program, [...existing, ...toInsert]);
    return toInsert.length;
  }

  async findExistingRecords(program: string, candidates: LiftRecord[]): Promise<LiftRecord[]> {
    const stored = this.store.get(program) ?? [];
    const existingKeys = new Set(stored.map(liftRecordNaturalKey));
    return candidates.filter((r) => existingKeys.has(liftRecordNaturalKey(r)));
  }

  async updateLiftRecord(
    program: string,
    id: string,
    updates: Partial<Pick<LiftRecord, 'weight' | 'reps' | 'notes'>>,
  ): Promise<LiftRecord | null> {
    const records = this.store.get(program) ?? [];
    const idx = records.findIndex((r) => buildLiftRecordId(r.program, r) === id);
    if (idx === -1) return null;
    const current = records[idx] as LiftRecord;
    const updated: LiftRecord = {
      ...current,
      weight: updates.weight ?? current.weight,
      reps: updates.reps ?? current.reps,
      notes: updates.notes ?? current.notes,
    };
    const next = [...records];
    next[idx] = updated;
    this.store.set(program, next);
    return updated;
  }

  async deleteLiftRecordsByNaturalKeys(program: string, naturalKeys: string[]): Promise<number> {
    if (naturalKeys.length === 0) return 0;
    const keySet = new Set(naturalKeys);
    const before = this.store.get(program) ?? [];
    const after = before.filter((r) => !keySet.has(liftRecordNaturalKey(r)));
    this.store.set(program, after);
    return before.length - after.length;
  }

  async deleteAllLiftRecords(program: string): Promise<void> {
    this.store.delete(program);
  }
}
