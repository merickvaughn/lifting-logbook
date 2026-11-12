import { TrainingMaxHistoryEntry, liftSpellings } from '@lifting-logbook/core';
import { ITrainingMaxHistoryRepository, TrainingMaxHistoryFilters } from '../../ports/ITrainingMaxHistoryRepository';
import { HistoryEntryNotFoundError } from '../../ports/errors';

export class InMemoryTrainingMaxHistoryRepository implements ITrainingMaxHistoryRepository {
  private entriesByProgram: Map<string, TrainingMaxHistoryEntry[]> = new Map();
  private nextId = 1;

  async getHistory(program: string, filters?: TrainingMaxHistoryFilters): Promise<TrainingMaxHistoryEntry[]> {
    // A modification's own-max entries aren't the lift's history (#1153).
    let entries = (this.entriesByProgram.get(program) ?? []).filter((e) => e.modificationId === undefined);
    if (filters?.lift !== undefined) {
      const wanted = liftSpellings(filters.lift);
      entries = entries.filter((e) => wanted.includes(e.lift));
    }
    if (filters?.source !== undefined) entries = entries.filter((e) => e.source === filters.source);
    if (filters?.isPR !== undefined) entries = entries.filter((e) => e.isPR === filters.isPR);
    return entries.sort((a, b) => b.date.getTime() - a.date.getTime());
  }

  async appendHistoryEntries(
    program: string,
    entries: Omit<TrainingMaxHistoryEntry, 'id'>[],
  ): Promise<void> {
    const existing = this.entriesByProgram.get(program) ?? [];
    const withIds = entries.map((e) => ({ ...e, id: String(this.nextId++) }));
    this.entriesByProgram.set(program, [...existing, ...withIds]);
  }

  async updateHistoryEntry(
    program: string,
    id: string,
    update: { isPR?: boolean; goalMet?: boolean },
  ): Promise<TrainingMaxHistoryEntry> {
    const entries = this.entriesByProgram.get(program) ?? [];
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) throw new HistoryEntryNotFoundError(id);
    const current = entries[idx] as TrainingMaxHistoryEntry;
    const updated: TrainingMaxHistoryEntry = {
      ...current,
      ...(update.isPR !== undefined && { isPR: update.isPR }),
      ...(update.goalMet !== undefined && { goalMet: update.goalMet }),
    };
    const next = [...entries];
    next[idx] = updated;
    this.entriesByProgram.set(program, next);
    return updated;
  }

  async deleteAllHistory(program: string): Promise<void> {
    this.entriesByProgram.delete(program);
  }
}
