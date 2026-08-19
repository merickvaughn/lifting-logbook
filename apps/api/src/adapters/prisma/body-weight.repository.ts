import { PrismaClient } from '@prisma/client';
import { BodyWeightEntry, WeightUnit } from '@lifting-logbook/types';
import { IBodyWeightRepository } from '../../ports/IBodyWeightRepository';

export class PrismaBodyWeightRepository implements IBodyWeightRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async recordBodyWeight(program: string, entry: BodyWeightEntry): Promise<void> {
    await this.prisma.bodyWeight.create({
      data: {
        userId: this.userId,
        program,
        date: entry.date,
        weight: entry.weight,
        unit: entry.unit,
      },
    });
  }

  // Returns the most recently *recorded* entry (insertion order via createdAt), not the entry
  // with the most recent `date` value. This preserves InMemoryBodyWeightRepository's pre-existing
  // `entries[entries.length - 1]` contract exactly. Whether "latest" should instead mean "most
  // recent by date" is a separate product question, out of scope for issue #904 (persistence +
  // per-user isolation only, not a change to query semantics).
  async getLatestBodyWeight(program: string): Promise<BodyWeightEntry | null> {
    const row = await this.prisma.bodyWeight.findFirst({
      where: { userId: this.userId, program },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return null;
    return { date: row.date, weight: row.weight, unit: row.unit as WeightUnit };
  }
}
