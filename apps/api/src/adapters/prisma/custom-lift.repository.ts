import { PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { CustomLift, JointAction, LiftClassification, MovementComplexity, MovementTag } from '@lifting-logbook/types';
import {
  CreateCustomLiftInput,
  ICustomLiftRepository,
  UpdateCustomLiftPatch,
} from '../../ports/ICustomLiftRepository';
import { CustomLiftConflictError, CustomLiftNotFoundError } from '../../ports/errors';

interface CustomLiftRow {
  id: string;
  userId: string;
  name: string;
  classification: string;
  patterns: string[];
  jointActions: string[];
  complexity: string;
  isBodyweightComponent: boolean;
  createdAt: Date;
}

export class PrismaCustomLiftRepository implements ICustomLiftRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async list(): Promise<CustomLift[]> {
    const rows = await this.prisma.customLift.findMany({
      where: { userId: this.userId },
      orderBy: { name: 'asc' },
    });
    return rows.map((r: CustomLiftRow) => this.toCustomLift(r));
  }

  async create(input: CreateCustomLiftInput): Promise<CustomLift> {
    try {
      const row = await this.prisma.customLift.create({
        data: {
          userId: this.userId,
          name: input.name,
          classification: input.classification,
          patterns: input.movementProfile?.patterns ?? [],
          jointActions: input.movementProfile?.jointActions ?? [],
          complexity: input.movementProfile?.complexity ?? 'simple',
          isBodyweightComponent: input.isBodyweightComponent ?? false,
        },
      });
      return this.toCustomLift(row);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new CustomLiftConflictError(input.name);
      }
      throw e;
    }
  }

  async update(id: string, patch: UpdateCustomLiftPatch): Promise<CustomLift> {
    // The PK is `id` alone, so guard on userId to preserve ownership isolation —
    // a bare where:{id} would let one user mutate another user's lift.
    const owned = await this.prisma.customLift.findFirst({ where: { id, userId: this.userId } });
    if (!owned) {
      throw new CustomLiftNotFoundError(id);
    }
    const data = {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.classification !== undefined ? { classification: patch.classification } : {}),
      ...(patch.movementProfile !== undefined
        ? {
            patterns: patch.movementProfile.patterns,
            jointActions: patch.movementProfile.jointActions,
            complexity: patch.movementProfile.complexity,
          }
        : {}),
      ...(patch.isBodyweightComponent !== undefined
        ? { isBodyweightComponent: patch.isBodyweightComponent }
        : {}),
    };
    try {
      const row = await this.prisma.customLift.update({ where: { id }, data });
      return this.toCustomLift(row);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new CustomLiftConflictError(patch.name ?? owned.name);
      }
      // The row can go between the ownership read and the write, such as on a double-tapped delete.
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new CustomLiftNotFoundError(id);
      }
      throw e;
    }
  }

  async delete(id: string): Promise<void> {
    // The write is scoped to userId, so it needs no prior ownership read: an absent row and
    // another user's row both come back as count 0, which is the isolation update() gets from
    // its findFirst. deleteMany reports a row gone since the request began as count 0 rather
    // than raising P2025, so a lost race is the documented 404 and not an unhandled 500.
    const { count } = await this.prisma.customLift.deleteMany({ where: { id, userId: this.userId } });
    if (count === 0) {
      throw new CustomLiftNotFoundError(id);
    }
  }

  private toCustomLift(row: CustomLiftRow): CustomLift {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      classification: row.classification as LiftClassification,
      movementProfile: {
        patterns: row.patterns as MovementTag[],
        jointActions: row.jointActions as JointAction[],
        complexity: row.complexity as MovementComplexity,
      },
      isBodyweightComponent: row.isBodyweightComponent,
      isCustom: true,
      createdAt: row.createdAt,
    };
  }
}
