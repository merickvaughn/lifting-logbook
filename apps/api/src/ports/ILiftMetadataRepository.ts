export interface LiftMetadata {
  lift: string;
  muscleGroups: string[];
  substitutions: string[];
  foundational: boolean;
}

export interface ILiftMetadataRepository {
  getMetadata(lift: string): Promise<LiftMetadata | null>;
  /**
   * Every metadata row the user has. `buildMuscleTargetResolver` must be built over all of
   * them, so legacy URL-encoded rows map onto their real names (#1017).
   */
  listMetadata(): Promise<LiftMetadata[]>;
  upsertMetadata(
    lift: string,
    patch: { muscleGroups?: string[]; substitutions?: string[]; foundational?: boolean },
  ): Promise<LiftMetadata>;
}
