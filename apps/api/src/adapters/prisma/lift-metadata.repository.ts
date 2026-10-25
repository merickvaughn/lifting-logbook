import { PrismaClient } from '@prisma/client';
import { ILiftMetadataRepository, LiftMetadata } from '../../ports/ILiftMetadataRepository';

export class PrismaLiftMetadataRepository implements ILiftMetadataRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getMetadata(lift: string): Promise<LiftMetadata | null> {
    const row = await this.prisma.liftMetadata.findUnique({
      where: { userId_lift: { userId: this.userId, lift } },
    });
    if (!row) return null;
    return {
      lift: row.lift,
      muscleGroups: row.muscleGroups,
      substitutions: row.substitutions,
      foundational: row.foundational,
    };
  }

  async listMetadata(): Promise<LiftMetadata[]> {
    const rows = await this.prisma.liftMetadata.findMany({ where: { userId: this.userId } });
    return rows.map((row) => ({
      lift: row.lift,
      muscleGroups: row.muscleGroups,
      substitutions: row.substitutions,
      foundational: row.foundational,
    }));
  }

  async upsertMetadata(
    lift: string,
    patch: { muscleGroups?: string[]; substitutions?: string[]; foundational?: boolean },
  ): Promise<LiftMetadata> {
    const update = {
      ...(patch.muscleGroups !== undefined ? { muscleGroups: patch.muscleGroups } : {}),
      ...(patch.substitutions !== undefined ? { substitutions: patch.substitutions } : {}),
      ...(patch.foundational !== undefined ? { foundational: patch.foundational } : {}),
    };
    const row = await this.prisma.liftMetadata.upsert({
      where: { userId_lift: { userId: this.userId, lift } },
      update,
      create: { userId: this.userId, lift, muscleGroups: [], substitutions: [], foundational: false, ...update },
    });
    return {
      lift: row.lift,
      muscleGroups: row.muscleGroups,
      substitutions: row.substitutions,
      foundational: row.foundational,
    };
  }
}
