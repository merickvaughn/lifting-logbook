import { ILiftMetadataRepository, LiftMetadata, LiftMetadataPatch } from '../../ports/ILiftMetadataRepository';

export class InMemoryLiftMetadataRepository implements ILiftMetadataRepository {
  private readonly store = new Map<string, LiftMetadata>();

  async getMetadata(lift: string): Promise<LiftMetadata | null> {
    return this.store.get(lift) ?? null;
  }

  async listMetadata(): Promise<LiftMetadata[]> {
    return [...this.store.values()];
  }

  // Mirrors PrismaLiftMetadataRepository: `undefined` leaves a field unchanged and `null`
  // clears a progression field.
  async upsertMetadata(lift: string, patch: LiftMetadataPatch): Promise<LiftMetadata> {
    const existing: LiftMetadata = this.store.get(lift) ?? {
      lift,
      muscleGroups: [],
      substitutions: [],
      foundational: false,
      progression: null,
      progressionIncrement: null,
      repsLow: null,
      repsHigh: null,
    };
    const updated: LiftMetadata = {
      lift,
      muscleGroups: patch.muscleGroups ?? existing.muscleGroups,
      substitutions: patch.substitutions ?? existing.substitutions,
      foundational: patch.foundational ?? existing.foundational,
      progression: patch.progression !== undefined ? patch.progression : existing.progression,
      progressionIncrement:
        patch.progressionIncrement !== undefined ? patch.progressionIncrement : existing.progressionIncrement,
      repsLow: patch.repsLow !== undefined ? patch.repsLow : existing.repsLow,
      repsHigh: patch.repsHigh !== undefined ? patch.repsHigh : existing.repsHigh,
    };
    this.store.set(lift, updated);
    return updated;
  }
}
