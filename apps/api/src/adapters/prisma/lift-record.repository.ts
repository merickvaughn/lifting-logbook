import { PrismaClient } from '@prisma/client';
// Prisma 5.x — error classes moved off the Prisma namespace
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import {
  LiftRecord,
  liftRecordNaturalKey,
  parseLiftRecordNaturalKey,
  parseYYYYMMDD,
} from '@lifting-logbook/core';
import { ILiftRecordRepository } from '../../ports/ILiftRecordRepository';

export class PrismaLiftRecordRepository implements ILiftRecordRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getLiftRecords(program: string, cycleNum: number): Promise<LiftRecord[]> {
    const rows = await this.prisma.liftRecord.findMany({
      where: { userId: this.userId, program, cycleNum },
    });
    return rows.map(rowToLiftRecord);
  }

  async appendLiftRecords(program: string, records: LiftRecord[]): Promise<number> {
    const { count } = await this.prisma.liftRecord.createMany({
      data: records.map((r) => ({
        userId: this.userId,
        program,
        cycleNum: r.cycleNum,
        workoutNum: r.workoutNum,
        date: r.date,
        lift: r.lift,
        setNum: r.setNum,
        weight: r.weight,
        reps: r.reps,
        notes: r.notes,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  async findExistingRecords(program: string, candidates: LiftRecord[]): Promise<LiftRecord[]> {
    if (candidates.length === 0) return [];

    // Chunk the OR array to stay within Postgres parameter limits (~32k).
    // Each candidate produces 5 bound parameters; 500 chunks ≈ 2500 params per query.
    const CHUNK_SIZE = 500;
    const chunks: LiftRecord[][] = [];
    for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
      chunks.push(candidates.slice(i, i + CHUNK_SIZE));
    }

    const rowGroups = await Promise.all(
      chunks.map((chunk) =>
        this.prisma.liftRecord.findMany({
          where: {
            userId: this.userId,
            program,
            OR: chunk.map((r) => ({
              cycleNum: r.cycleNum,
              workoutNum: r.workoutNum,
              date: r.date,
              lift: r.lift,
              setNum: r.setNum,
            })),
          },
        }),
      ),
    );

    const existingKeys = new Set(rowGroups.flat().map(liftRecordNaturalKey));
    return candidates.filter((r) => existingKeys.has(liftRecordNaturalKey(r)));
  }

  async updateLiftRecord(
    program: string,
    id: string,
    updates: Partial<Pick<LiftRecord, 'weight' | 'reps' | 'notes'>>,
  ): Promise<LiftRecord | null> {
    const parsed = parseLiftRecordId(program, id);
    if (!parsed) return null;

    try {
      const updated = await this.prisma.liftRecord.update({
        where: {
          userId_program_cycleNum_workoutNum_date_lift_setNum: {
            userId: this.userId,
            program,
            ...parsed,
          },
        },
        data: {
          ...(updates.weight !== undefined && { weight: updates.weight }),
          ...(updates.reps !== undefined && { reps: updates.reps }),
          ...(updates.notes !== undefined && { notes: updates.notes }),
        },
      });
      return rowToLiftRecord(updated);
    } catch (e) {
      if (e instanceof PrismaClientKnownRequestError && e.code === 'P2025') {
        return null;
      }
      throw e;
    }
  }

  async deleteLiftRecordsByNaturalKeys(program: string, naturalKeys: string[]): Promise<number> {
    if (naturalKeys.length === 0) return 0;
    // ImportBatch.preImage rows persisted before date joined the key (issue
    // #884) still hold pre-#884 4-segment keys, which parseLiftRecordNaturalKey
    // now rejects — undoing one of those older batches would otherwise delete
    // zero rows and report a false "not found" for records that are still
    // there. Fall back to the legacy date-blind parse (and a date-blind OR
    // clause) for exactly the keys the new parser rejects, preserving undo's
    // pre-#884 behavior for pre-#884 data without weakening the current
    // parser's contract for current data.
    const clauses: Array<{
      cycleNum: number;
      workoutNum: number;
      date?: Date;
      lift: string;
      setNum: number;
    }> = [];
    for (const k of naturalKeys) {
      const p = parseLiftRecordNaturalKey(k);
      if (p) {
        clauses.push({
          cycleNum: p.cycleNum,
          workoutNum: p.workoutNum,
          date: p.date,
          lift: p.lift,
          setNum: p.setNum,
        });
        continue;
      }
      const legacy = parseLegacyLiftRecordNaturalKey(k);
      if (legacy) clauses.push(legacy);
    }
    if (clauses.length === 0) return 0;
    const { count } = await this.prisma.liftRecord.deleteMany({
      where: {
        userId: this.userId,
        program,
        OR: clauses,
      },
    });
    return count;
  }

  async deleteAllLiftRecords(program: string): Promise<void> {
    await this.prisma.liftRecord.deleteMany({
      where: { userId: this.userId, program },
    });
  }
}

// ID format: ${program}-${cycleNum}-${workoutNum}-${YYYYMMDD}-${lift}-${setNum}
// cycleNum, workoutNum, setNum are integers; date is 8 UTC digits (no internal
// delimiter, so it can never be confused with a hyphen inside the lift name,
// e.g. "Chin-up", "Romanian Dead-lift"); lift may itself contain hyphens.
//
// A pre-#884 id (no date segment) fails the segment-count check below and
// returns null, which callers already treat as "not found" (404 / no-op) —
// a safe failure mode rather than misparsing an old-format id as some other
// record.
function parseLiftRecordId(
  program: string,
  id: string,
): { cycleNum: number; workoutNum: number; date: Date; lift: string; setNum: number } | null {
  const prefix = `${program}-`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const parts = rest.split('-');
  if (parts.length < 5) return null;

  const cycleNum = parseInt(parts[0] ?? '', 10);
  const workoutNum = parseInt(parts[1] ?? '', 10);
  const date = parseYYYYMMDD(parts[2] ?? '');
  const setNum = parseInt(parts[parts.length - 1] ?? '', 10);
  const lift = parts.slice(3, parts.length - 1).join('-');

  if (isNaN(cycleNum) || isNaN(workoutNum) || !date || isNaN(setNum) || !lift) return null;
  return { cycleNum, workoutNum, date, lift, setNum };
}

// Parses a pre-#884 natural key with no date segment:
// "cycleNum:workoutNum:lift:setNum". Exists only so undo still works against
// ImportBatch.preImage rows persisted before date joined the key — see the
// call site in deleteLiftRecordsByNaturalKeys. Returns a date-less clause
// (matches any date for that cycle/workout/lift/set), the same date-blind
// behavior undo had before this issue's fix.
function parseLegacyLiftRecordNaturalKey(
  key: string,
): { cycleNum: number; workoutNum: number; lift: string; setNum: number } | null {
  const parts = key.split(':');
  if (parts.length < 4) return null;
  const cycleNum = parseInt(parts[0] ?? '', 10);
  const workoutNum = parseInt(parts[1] ?? '', 10);
  const setNum = parseInt(parts[parts.length - 1] ?? '', 10);
  const lift = parts.slice(2, parts.length - 1).join(':');
  if (isNaN(cycleNum) || isNaN(workoutNum) || isNaN(setNum) || !lift) return null;
  return { cycleNum, workoutNum, lift, setNum };
}

export function rowToLiftRecord(row: {
  program: string;
  cycleNum: number;
  workoutNum: number;
  date: Date;
  lift: string;
  setNum: number;
  weight: number;
  reps: number;
  notes: string;
}): LiftRecord {
  return {
    program: row.program,
    cycleNum: row.cycleNum,
    workoutNum: row.workoutNum,
    date: row.date,
    lift: row.lift,
    setNum: row.setNum,
    weight: row.weight,
    reps: row.reps,
    notes: row.notes,
  };
}
