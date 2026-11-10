import {
  LiftRecord,
  buildLiftRecordId,
  findAlreadyLogged,
  liftRecordNaturalKey,
  liftSpellings,
  withModifications,
} from '@lifting-logbook/core';
import { DateRange, dateRangesByMacrocycle, ILiftRecordRepository } from '../../ports/ILiftRecordRepository';

export class InMemoryLiftRecordRepository implements ILiftRecordRepository {
  constructor(private readonly store: Map<string, LiftRecord[]>) {}

  async getLiftRecords(program: string, macrocycleNum: number): Promise<LiftRecord[]> {
    return (this.store.get(program) ?? []).filter((r) => r.macrocycleNum === macrocycleNum);
  }

  async getLoggedWorkoutNums(program: string, macrocycleNum: number): Promise<Set<number>> {
    return new Set(
      (this.store.get(program) ?? [])
        .filter((r) => r.macrocycleNum === macrocycleNum)
        .map((r) => r.workoutNum),
    );
  }

  async getRecordsForLifts(lifts: readonly string[], through: Date): Promise<LiftRecord[]> {
    const wanted = new Set(lifts.flatMap(liftSpellings));
    return [...this.store.values()]
      .flat()
      .filter((r) => wanted.has(r.lift) && r.date.getTime() <= through.getTime());
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
    return findAlreadyLogged(candidates, this.store.get(program) ?? []);
  }

  async updateLiftRecord(
    program: string,
    id: string,
    updates: Partial<Pick<LiftRecord, 'weight' | 'reps' | 'notes' | 'modifications'>>,
  ): Promise<LiftRecord | null> {
    const records = this.store.get(program) ?? [];
    const idx = records.findIndex((r) => buildLiftRecordId(r.program, r) === id);
    if (idx === -1) return null;
    const { modifications, ...current } = records[idx] as LiftRecord;
    const updated: LiftRecord = {
      ...current,
      weight: updates.weight ?? current.weight,
      reps: updates.reps ?? current.reps,
      notes: updates.notes ?? current.notes,
      ...withModifications(updates.modifications ?? modifications),
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

  async getMacrocycleDateRanges(program: string, macrocycleNum?: number): Promise<Map<number, DateRange>> {
    const records = this.store.get(program) ?? [];
    return dateRangesByMacrocycle(
      macrocycleNum === undefined ? records : records.filter((r) => r.macrocycleNum === macrocycleNum),
    );
  }

  async deleteAllLiftRecords(program: string, keep: readonly number[] = []): Promise<void> {
    const kept = (this.store.get(program) ?? []).filter((r) => keep.includes(r.macrocycleNum));
    if (kept.length > 0) this.store.set(program, kept);
    else this.store.delete(program);
  }
}
