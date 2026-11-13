import { PrismaClient } from '@prisma/client';
// Prisma 5.x — error classes moved off the Prisma namespace
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import {
  LiftRecord,
  SetSlot,
  liftSpellings,
  parseLiftRecordId,
  parseLiftRecordNaturalKey,
  withModifications,
  withOccurrence,
} from '@lifting-logbook/core';
import {
  DateRange,
  ILiftRecordRepository,
  LastSessionsBefore,
  latestWorkoutByLift,
} from '../../ports/ILiftRecordRepository';

export class PrismaLiftRecordRepository implements ILiftRecordRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  async getLiftRecords(program: string, macrocycleNum: number, workoutNum?: number): Promise<LiftRecord[]> {
    const rows = await this.prisma.liftRecord.findMany({
      where: { userId: this.userId, program, macrocycleNum, ...(workoutNum === undefined ? {} : { workoutNum }) },
    });
    return rows.map(rowToLiftRecord);
  }

  async getLoggedWorkoutNums(program: string, macrocycleNum: number): Promise<Set<number>> {
    // `groupBy`, not `findMany({ distinct })`: without the `nativeDistinct`
    // preview feature Prisma implements `distinct` in the query engine (fetch
    // every matching row, dedupe in memory), which is the round-trip this method
    // exists to avoid. `groupBy` emits SQL `GROUP BY` and is served index-only by
    // `@@index([userId, program, macrocycleNum, workoutNum])`.
    const rows = await this.prisma.liftRecord.groupBy({
      by: ['workoutNum'],
      where: { userId: this.userId, program, macrocycleNum },
    });
    return new Set(rows.map((r) => r.workoutNum));
  }

  async getLastSessions(
    program: string,
    macrocycleNum: number,
    lifts: readonly string[],
    { workoutNum, through }: LastSessionsBefore,
  ): Promise<LiftRecord[]> {
    if (lifts.length === 0) return [];
    const where = {
      userId: this.userId,
      program,
      macrocycleNum,
      workoutNum: { not: workoutNum },
      occurrence: 0,
      date: { lte: through },
    };
    // The lifts' sessions first, one row per stored spelling, workout and date: grouped in SQL,
    // so no set is read until the latest session is known.
    const sessions = await this.prisma.liftRecord.groupBy({
      by: ['lift', 'workoutNum', 'date'],
      where: { ...where, lift: { in: [...new Set(lifts.flatMap(liftSpellings))] } },
    });
    const latest = latestWorkoutByLift(sessions);
    if (latest.size === 0) return [];
    const rows = await this.prisma.liftRecord.findMany({
      where: {
        ...where,
        OR: [...latest].map(([id, latestNum]) => ({ workoutNum: latestNum, lift: { in: [...liftSpellings(id)] } })),
      },
    });
    return rows.map(rowToLiftRecord);
  }

  async getRecordsForLifts(lifts: readonly string[], through: Date, from?: Date): Promise<LiftRecord[]> {
    if (lifts.length === 0) return [];
    const rows = await this.prisma.liftRecord.findMany({
      where: {
        userId: this.userId,
        lift: { in: [...new Set(lifts.flatMap(liftSpellings))] },
        date: { lte: through, ...(from ? { gte: from } : {}) },
      },
    });
    return rows.map(rowToLiftRecord);
  }

  async getLoggedLifts(program: string): Promise<string[]> {
    // Grouped in SQL over the unique index's `(userId, program)` prefix: it returns no sets, but
    // scans one index entry per stored set in the program.
    const rows = await this.prisma.liftRecord.groupBy({ by: ['lift'], where: { userId: this.userId, program } });
    return rows.map((r) => r.lift);
  }

  async getProgramRecordsForLifts(program: string, lifts: readonly string[]): Promise<LiftRecord[]> {
    if (lifts.length === 0) return [];
    const rows = await this.prisma.liftRecord.findMany({
      where: { userId: this.userId, program, lift: { in: [...new Set(lifts)] } },
      // Only what the missing-training-max list reads; a lift with no max can hold years of sets.
      select: {
        program: true,
        macrocycleNum: true,
        workoutNum: true,
        date: true,
        lift: true,
        occurrence: true,
        setNum: true,
        weight: true,
        reps: true,
        modifications: true,
      },
    });
    return rows.map((r) => rowToLiftRecord({ ...r, notes: '' }));
  }

  async appendLiftRecords(program: string, records: LiftRecord[]): Promise<number> {
    const { count } = await this.prisma.liftRecord.createMany({
      data: records.map((r) => ({
        userId: this.userId,
        program,
        macrocycleNum: r.macrocycleNum,
        workoutNum: r.workoutNum,
        date: r.date,
        lift: r.lift,
        occurrence: r.occurrence ?? 0,
        setNum: r.setNum,
        weight: r.weight,
        reps: r.reps,
        notes: r.notes,
        modifications: r.modifications ?? [],
      })),
      skipDuplicates: true,
    });
    return count;
  }

  async findStoredSets(slots: readonly SetSlot[]): Promise<LiftRecord[]> {
    // One condition per date, naming every spelling of every lift on it, so the lookup stays on
    // the (userId, lift, date) index. A 5,000-row file spans a few hundred dates at most.
    const liftsByDate = new Map<number, Set<string>>();
    for (const { date, lift } of slots) {
      const lifts = liftsByDate.get(date.getTime()) ?? new Set<string>();
      for (const spelling of liftSpellings(lift)) lifts.add(spelling);
      liftsByDate.set(date.getTime(), lifts);
    }
    if (liftsByDate.size === 0) return [];
    // Each date binds one parameter for itself and one per spelling, so chunks are cut by a
    // running count, well under Postgres's bound-parameter limit (32,767).
    const MAX_PARAMS = 10_000;
    const chunks: Array<Array<[number, Set<string>]>> = [[]];
    let params = 0;
    for (const entry of liftsByDate) {
      const cost = 1 + entry[1].size;
      if (params + cost > MAX_PARAMS && (chunks[chunks.length - 1]?.length ?? 0) > 0) {
        chunks.push([]);
        params = 0;
      }
      chunks[chunks.length - 1]?.push(entry);
      params += cost;
    }
    const records: LiftRecord[] = [];
    // Sequential: every query shares the request's one transaction connection.
    for (const chunk of chunks) {
      const rows = await this.prisma.liftRecord.findMany({
        where: {
          userId: this.userId,
          OR: chunk.map(([time, lifts]) => ({ date: new Date(time), lift: { in: [...lifts] } })),
        },
      });
      records.push(...rows.map(rowToLiftRecord));
    }
    return records;
  }

  async updateLiftRecord(
    program: string,
    id: string,
    updates: Partial<Pick<LiftRecord, 'weight' | 'reps' | 'notes' | 'modifications'>>,
  ): Promise<LiftRecord | null> {
    const parsed = parseLiftRecordId(program, id);
    if (!parsed) return null;

    try {
      const updated = await this.prisma.liftRecord.update({
        where: {
          userId_program_macrocycleNum_workoutNum_date_lift_occurrence_setNum: {
            userId: this.userId,
            program,
            ...parsed,
            occurrence: parsed.occurrence ?? 0,
          },
        },
        data: {
          ...(updates.weight !== undefined && { weight: updates.weight }),
          ...(updates.reps !== undefined && { reps: updates.reps }),
          ...(updates.notes !== undefined && { notes: updates.notes }),
          ...(updates.modifications !== undefined && { modifications: updates.modifications }),
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
      macrocycleNum: number;
      workoutNum: number;
      date?: Date;
      lift: string;
      occurrence: number;
      setNum: number;
    }> = [];
    for (const k of naturalKeys) {
      const p = parseLiftRecordNaturalKey(k);
      if (p) {
        clauses.push({
          macrocycleNum: p.macrocycleNum,
          workoutNum: p.workoutNum,
          date: p.date,
          lift: p.lift,
          occurrence: p.occurrence ?? 0,
          setNum: p.setNum,
        });
        continue;
      }
      // A legacy key predates `occurrence` (#1027), when every row was occurrence 0.
      const legacy = parseLegacyLiftRecordNaturalKey(k);
      if (legacy) clauses.push({ ...legacy, occurrence: 0 });
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

  async getMacrocycleDateRanges(program: string, macrocycleNum?: number): Promise<Map<number, DateRange>> {
    // Grouped in SQL and served by `@@index([userId, program, macrocycleNum])`, so listing a
    // program's macrocycles reads no sets.
    const rows = await this.prisma.liftRecord.groupBy({
      by: ['macrocycleNum'],
      where: { userId: this.userId, program, ...(macrocycleNum === undefined ? {} : { macrocycleNum }) },
      _min: { date: true },
      _max: { date: true },
    });
    const ranges = new Map<number, DateRange>();
    for (const r of rows) {
      if (r._min.date && r._max.date) ranges.set(r.macrocycleNum, { first: r._min.date, last: r._max.date });
    }
    return ranges;
  }
}

// Parses a pre-#884 natural key with no date segment:
// "macrocycleNum:workoutNum:lift:setNum". Exists only so undo still works against
// ImportBatch.preImage rows persisted before date joined the key — see the
// call site in deleteLiftRecordsByNaturalKeys. Returns a date-less clause
// (matches any date for that macrocycle/workout/lift/set), the same date-blind
// behavior undo had before this issue's fix.
function parseLegacyLiftRecordNaturalKey(
  key: string,
): { macrocycleNum: number; workoutNum: number; lift: string; setNum: number } | null {
  const parts = key.split(':');
  if (parts.length < 4) return null;
  const macrocycleNum = parseInt(parts[0] ?? '', 10);
  const workoutNum = parseInt(parts[1] ?? '', 10);
  const setNum = parseInt(parts[parts.length - 1] ?? '', 10);
  const lift = parts.slice(2, parts.length - 1).join(':');
  if (isNaN(macrocycleNum) || isNaN(workoutNum) || isNaN(setNum) || !lift) return null;
  return { macrocycleNum, workoutNum, lift, setNum };
}

export function rowToLiftRecord(row: {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  date: Date;
  lift: string;
  occurrence?: number;
  setNum: number;
  weight: number;
  reps: number;
  notes: string;
  modifications?: string[];
}): LiftRecord {
  return {
    program: row.program,
    macrocycleNum: row.macrocycleNum,
    workoutNum: row.workoutNum,
    date: row.date,
    lift: row.lift,
    // Left absent at 0, as the record type reads it, so a first occurrence's record
    // is the shape it was before occurrences existed (#1027).
    ...withOccurrence(row.occurrence),
    setNum: row.setNum,
    weight: row.weight,
    reps: row.reps,
    notes: row.notes,
    ...withModifications(row.modifications),
  };
}
