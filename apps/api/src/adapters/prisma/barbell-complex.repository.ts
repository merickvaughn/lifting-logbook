import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { BarbellComplex, ComplexComponent } from '@lifting-logbook/types';
import {
  CreateBarbellComplexInput,
  IBarbellComplexRepository,
  UpdateBarbellComplexPatch,
} from '../../ports/IBarbellComplexRepository';
import { BarbellComplexConflictError, BarbellComplexNotFoundError } from '../../ports/errors';

interface BarbellComplexRow {
  id: string;
  userId: string;
  name: string;
  components: Prisma.JsonValue;
  createdAt: Date;
}

export class PrismaBarbellComplexRepository implements IBarbellComplexRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async list(): Promise<BarbellComplex[]> {
    const rows = await this.prisma.barbellComplex.findMany({
      where: { userId: this.userId },
      orderBy: { name: 'asc' },
    });
    return rows.map(toBarbellComplex);
  }

  async create(input: CreateBarbellComplexInput): Promise<BarbellComplex> {
    try {
      const row = await this.prisma.barbellComplex.create({
        data: { userId: this.userId, name: input.name, components: toJson(input.components) },
      });
      return toBarbellComplex(row);
    } catch (e) {
      throw translateWriteError(e, '', input.name);
    }
  }

  async update(id: string, patch: UpdateBarbellComplexPatch): Promise<BarbellComplex> {
    // The PK is `id` alone, so guard on userId, as PrismaLiftModificationRepository does.
    const owned = await this.prisma.barbellComplex.findFirst({ where: { id, userId: this.userId } });
    if (!owned) throw new BarbellComplexNotFoundError(id);
    try {
      const row = await this.prisma.barbellComplex.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.components !== undefined ? { components: toJson(patch.components) } : {}),
        },
      });
      return toBarbellComplex(row);
    } catch (e) {
      throw translateWriteError(e, id, patch.name ?? owned.name);
    }
  }

  async delete(id: string): Promise<void> {
    const { count } = await this.prisma.barbellComplex.deleteMany({ where: { id, userId: this.userId } });
    if (count === 0) throw new BarbellComplexNotFoundError(id);
  }
}

/** A row can go between the ownership read and the write, so P2025 is the documented not found. */
function translateWriteError(e: unknown, id: string, name: string): unknown {
  if (e instanceof PrismaClientKnownRequestError) {
    if (e.code === 'P2002') return new BarbellComplexConflictError(name);
    if (e.code === 'P2025') return new BarbellComplexNotFoundError(id);
  }
  return e;
}

/** Only the two fields, in order, whatever else the caller's objects carry. */
function toJson(components: readonly ComplexComponent[]): Prisma.InputJsonValue {
  return components.map(({ lift, reps }) => ({ lift, reps }));
}

function toBarbellComplex(row: BarbellComplexRow): BarbellComplex {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    // Written only through `toJson`, under the DTO's checks.
    components: row.components as unknown as ComplexComponent[],
    createdAt: row.createdAt,
  };
}
