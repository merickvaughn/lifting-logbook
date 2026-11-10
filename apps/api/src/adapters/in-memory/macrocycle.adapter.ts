import { randomUUID } from 'node:crypto';
import { MacrocycleStatus } from '@lifting-logbook/types';
import { MacrocycleNumberConflictError } from '../../ports/errors';
import { IMacrocycleRepository, MacrocycleRow, NewMacrocycle } from '../../ports/IMacrocycleRepository';

export class InMemoryMacrocycleRepository implements IMacrocycleRepository {
  private readonly rows: MacrocycleRow[] = [];

  constructor(seed: readonly MacrocycleRow[] = []) {
    this.rows.push(...seed.map((row) => ({ ...row })));
  }

  async list(program: string): Promise<MacrocycleRow[]> {
    return this.rows
      .filter((r) => r.program === program)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.macrocycleNum - b.macrocycleNum)
      .map((r) => ({ ...r }));
  }

  async findByNumber(program: string, macrocycleNum: number): Promise<MacrocycleRow | null> {
    const row = this.rows.find((r) => r.program === program && r.macrocycleNum === macrocycleNum);
    return row ? { ...row } : null;
  }

  async highestNumber(program: string): Promise<number> {
    return this.rows.filter((r) => r.program === program).reduce((max, r) => Math.max(max, r.macrocycleNum), 0);
  }

  async create(macrocycle: NewMacrocycle): Promise<MacrocycleRow> {
    if (await this.findByNumber(macrocycle.program, macrocycle.macrocycleNum)) {
      throw new MacrocycleNumberConflictError(macrocycle.program, macrocycle.macrocycleNum);
    }
    const row: MacrocycleRow = {
      id: randomUUID(),
      program: macrocycle.program,
      macrocycleNum: macrocycle.macrocycleNum,
      startDate: macrocycle.startDate,
      endDate: macrocycle.endDate ?? null,
      status: macrocycle.status,
      statusChosen: false,
      origin: macrocycle.origin,
      unmatched: false,
      importedThrough: null,
    };
    this.rows.push(row);
    return { ...row };
  }

  async close(
    program: string,
    macrocycleNum: number,
    end: { endDate: Date | null; status: MacrocycleStatus },
  ): Promise<void> {
    const row = this.rows.find((r) => r.program === program && r.macrocycleNum === macrocycleNum);
    if (!row) return;
    row.endDate = end.endDate;
    if (!row.statusChosen) row.status = end.status;
  }

  async deleteAllExcept(program: string, keep: readonly number[]): Promise<void> {
    const kept = this.rows.filter((r) => r.program !== program || keep.includes(r.macrocycleNum));
    this.rows.splice(0, this.rows.length, ...kept);
  }

  /** Test seam: puts a row in as stored, as the db e2e suites do through the owner client. */
  seed(row: Omit<MacrocycleRow, 'id'> & { id?: string }): MacrocycleRow {
    const stored = { ...row, id: row.id ?? randomUUID() };
    this.rows.push(stored);
    return { ...stored };
  }
}
