import { PrismaClient } from '@prisma/client';
import { isLiftProgressionType } from '@lifting-logbook/types';
import { ILiftMetadataRepository, LiftMetadata, LiftMetadataPatch } from '../../ports/ILiftMetadataRepository';

type LiftMetadataRow = {
  lift: string;
  muscleGroups: string[];
  substitutions: string[];
  foundational: boolean;
  progression: string | null;
  progressionIncrement: number | null;
  repsLow: number | null;
  repsHigh: number | null;
};

function toMetadata(row: LiftMetadataRow): LiftMetadata {
  return {
    lift: row.lift,
    muscleGroups: row.muscleGroups,
    substitutions: row.substitutions,
    foundational: row.foundational,
    // An unknown stored value reads as unset, so the lifter's default applies (#1210).
    progression: isLiftProgressionType(row.progression) ? row.progression : null,
    progressionIncrement: row.progressionIncrement,
    repsLow: row.repsLow,
    repsHigh: row.repsHigh,
  };
}

export class PrismaLiftMetadataRepository implements ILiftMetadataRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getMetadata(lift: string): Promise<LiftMetadata | null> {
    const row = await this.prisma.liftMetadata.findUnique({
      where: { userId_lift: { userId: this.userId, lift } },
    });
    return row ? toMetadata(row) : null;
  }

  async listMetadata(): Promise<LiftMetadata[]> {
    const rows = await this.prisma.liftMetadata.findMany({ where: { userId: this.userId } });
    return rows.map(toMetadata);
  }

  async upsertMetadata(lift: string, patch: LiftMetadataPatch): Promise<LiftMetadata> {
    const update = {
      ...(patch.muscleGroups !== undefined ? { muscleGroups: patch.muscleGroups } : {}),
      ...(patch.substitutions !== undefined ? { substitutions: patch.substitutions } : {}),
      ...(patch.foundational !== undefined ? { foundational: patch.foundational } : {}),
      ...(patch.progression !== undefined ? { progression: patch.progression } : {}),
      ...(patch.progressionIncrement !== undefined ? { progressionIncrement: patch.progressionIncrement } : {}),
      ...(patch.repsLow !== undefined ? { repsLow: patch.repsLow } : {}),
      ...(patch.repsHigh !== undefined ? { repsHigh: patch.repsHigh } : {}),
    };
    const row = await this.prisma.liftMetadata.upsert({
      where: { userId_lift: { userId: this.userId, lift } },
      update,
      create: { userId: this.userId, lift, muscleGroups: [], substitutions: [], foundational: false, ...update },
    });
    return toMetadata(row);
  }
}
