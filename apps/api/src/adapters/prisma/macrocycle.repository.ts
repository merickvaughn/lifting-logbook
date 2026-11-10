import { Macrocycle, PrismaClient } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { MacrocycleOrigin, MacrocycleStatus } from '@lifting-logbook/types';
import { MacrocycleNumberConflictError } from '../../ports/errors';
import { IMacrocycleRepository, MacrocycleRow, NewMacrocycle } from '../../ports/IMacrocycleRepository';

function toRow(row: Macrocycle): MacrocycleRow {
  return {
    id: row.id,
    program: row.program,
    macrocycleNum: row.macrocycleNum,
    startDate: row.startDate,
    endDate: row.endDate,
    // The table's CHECK constraints hold these to the shared lists.
    status: row.status as MacrocycleStatus,
    statusChosen: row.statusChosen,
    origin: row.origin as MacrocycleOrigin,
    unmatched: row.unmatched,
    importedThrough: row.importedThrough,
  };
}

export class PrismaMacrocycleRepository implements IMacrocycleRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async list(program: string): Promise<MacrocycleRow[]> {
    const rows = await this.prisma.macrocycle.findMany({
      where: { userId: this.userId, program },
      orderBy: [{ startDate: 'asc' }, { macrocycleNum: 'asc' }],
    });
    return rows.map(toRow);
  }

  async findByNumber(program: string, macrocycleNum: number): Promise<MacrocycleRow | null> {
    const row = await this.prisma.macrocycle.findUnique({
      where: { userId_program_macrocycleNum: { userId: this.userId, program, macrocycleNum } },
    });
    return row ? toRow(row) : null;
  }

  async highestNumber(program: string): Promise<number> {
    const { _max } = await this.prisma.macrocycle.aggregate({
      where: { userId: this.userId, program },
      _max: { macrocycleNum: true },
    });
    return _max.macrocycleNum ?? 0;
  }

  async create(macrocycle: NewMacrocycle): Promise<MacrocycleRow> {
    try {
      const row = await this.prisma.macrocycle.create({
        data: {
          userId: this.userId,
          program: macrocycle.program,
          macrocycleNum: macrocycle.macrocycleNum,
          startDate: macrocycle.startDate,
          endDate: macrocycle.endDate ?? null,
          status: macrocycle.status,
          origin: macrocycle.origin,
        },
      });
      return toRow(row);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new MacrocycleNumberConflictError(macrocycle.program, macrocycle.macrocycleNum);
      }
      throw e;
    }
  }

  async ensure(macrocycles: readonly NewMacrocycle[]): Promise<void> {
    if (macrocycles.length === 0) return;
    // ON CONFLICT DO NOTHING: a row a concurrent request just inserted is kept, not a 409.
    await this.prisma.macrocycle.createMany({
      data: macrocycles.map((m) => ({
        userId: this.userId,
        program: m.program,
        macrocycleNum: m.macrocycleNum,
        startDate: m.startDate,
        endDate: m.endDate ?? null,
        status: m.status,
        origin: m.origin,
      })),
      skipDuplicates: true,
    });
  }

  async close(program: string, macrocycleNum: number, end: { endDate: Date; status: MacrocycleStatus }): Promise<void> {
    await this.prisma.macrocycle.updateMany({
      where: { userId: this.userId, program, macrocycleNum },
      data: { endDate: end.endDate, status: end.status },
    });
  }

  async delete(program: string, macrocycleNums: readonly number[]): Promise<void> {
    if (macrocycleNums.length === 0) return;
    await this.prisma.macrocycle.deleteMany({
      where: { userId: this.userId, program, macrocycleNum: { in: [...macrocycleNums] } },
    });
  }

  async deleteAllExcept(program: string, keep: readonly number[]): Promise<void> {
    await this.prisma.macrocycle.deleteMany({
      where: { userId: this.userId, program, macrocycleNum: { notIn: [...keep] } },
    });
  }
}
