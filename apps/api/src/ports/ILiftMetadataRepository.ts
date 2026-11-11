import type { LiftProgressionType } from '@lifting-logbook/types';

export interface LiftMetadata {
  lift: string;
  muscleGroups: string[];
  substitutions: string[];
  foundational: boolean;
  /** The lift's own progression (#1210). Null falls through to the lifter's default. */
  progression: LiftProgressionType | null;
  progressionIncrement: number | null;
  repsLow: number | null;
  repsHigh: number | null;
}

/** An omitted field is left unchanged; `null` clears a progression field. */
export interface LiftMetadataPatch {
  muscleGroups?: string[];
  substitutions?: string[];
  foundational?: boolean;
  progression?: LiftProgressionType | null;
  progressionIncrement?: number | null;
  repsLow?: number | null;
  repsHigh?: number | null;
}

export interface ILiftMetadataRepository {
  getMetadata(lift: string): Promise<LiftMetadata | null>;
  /**
   * Every metadata row the user has. `buildMuscleTargetResolver` must be built over all of
   * them, so legacy URL-encoded rows map onto their real names (#1017).
   */
  listMetadata(): Promise<LiftMetadata[]>;
  upsertMetadata(lift: string, patch: LiftMetadataPatch): Promise<LiftMetadata>;
}
