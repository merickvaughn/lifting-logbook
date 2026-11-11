import { randomUUID } from 'node:crypto';
import { MacrocycleStatus } from '@lifting-logbook/types';
import { MacrocycleNumberConflictError } from '../../ports/errors';
import { IMacrocycleRepository, MacrocycleRow, NewMacrocycle } from '../../ports/IMacrocycleRepository';

/**
 * A stored row for tests: a `live`, `in-progress` 5-3-1 macrocycle starting on the first of
 * month `macrocycleNum` of 2026, with `overrides` on top.
 */
export function macrocycleRowFixture(macrocycleNum: number, overrides: Partial<MacrocycleRow> = {}): MacrocycleRow {
  return {
    id: `m-${macrocycleNum}`,
    program: '5-3-1',
    macrocycleNum,
    startDate: new Date(Date.UTC(2026, macrocycleNum, 1)),
    endDate: null,
    status: 'in-progress',
    statusChosen: false,
    origin: 'live',
    unmatched: false,
    importedThrough: null,
    ...overrides,
  };
}

export class InMemoryMacrocycleRepository implements IMacrocycleRepository {
  private readonly rows: MacrocycleRow[] = [];

  /**
   * Who else holds the user's macrocycle lock, for tests: `exclusive` (an import) makes every
   * lock fail, and `shared` (a page write) makes only the exclusive one fail, as if its wait ran
   * out.
   */
  lockHeld: 'shared' | 'exclusive' | null = null;

  constructor(seed: readonly MacrocycleRow[] = []) {
    this.rows.push(...seed.map((row) => ({ ...row })));
  }

  async tryLockShared(): Promise<boolean> {
    return this.lockHeld !== 'exclusive';
  }

  async lockExclusive(): Promise<boolean> {
    return this.lockHeld === null;
  }

  async findById(id: string): Promise<MacrocycleRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : null;
  }

  /** Changes a row's number in place, as the renumbering in #1199 will, for tests. */
  renumber(program: string, from: number, to: number): void {
    const row = this.rows.find((r) => r.program === program && r.macrocycleNum === from);
    if (row) row.macrocycleNum = to;
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

  async ensure(macrocycles: readonly NewMacrocycle[]): Promise<void> {
    for (const macrocycle of macrocycles) {
      if (!(await this.findByNumber(macrocycle.program, macrocycle.macrocycleNum))) await this.create(macrocycle);
    }
  }

  async close(program: string, macrocycleNum: number, end: { endDate: Date; status: MacrocycleStatus }): Promise<void> {
    const row = this.rows.find((r) => r.program === program && r.macrocycleNum === macrocycleNum);
    if (!row) return;
    row.endDate = end.endDate;
    row.status = end.status;
  }

  async delete(program: string, macrocycleNums: readonly number[]): Promise<void> {
    const kept = this.rows.filter((r) => r.program !== program || !macrocycleNums.includes(r.macrocycleNum));
    this.rows.splice(0, this.rows.length, ...kept);
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
