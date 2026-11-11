import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  LiftingProgramSpec,
  classifyAndCount,
  programSpecNaturalKey,
  parseProgramSpecNaturalKey,
  programSpecRowKind,
  normalizeAmrap,
} from '@lifting-logbook/core';
import {
  ILiftingProgramSpecRepository,
  SaveProgramSpecResult,
} from '../../ports/ILiftingProgramSpecRepository';
import { PrismaClient } from '@prisma/client';
import { isLiftProgressionType } from '@lifting-logbook/types';
import { InMemoryLiftingProgramSpecRepository } from '../in-memory/lifting-program-spec.adapter';
import { IMPORT_BATCH_TX_OPTIONS, runInteractive } from './prisma-tx.util';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SpecRow = {
  week: number;
  offset: number;
  lift: string;
  increment: number;
  order: number;
  sets: number;
  reps: number;
  amrap: boolean;
  warmUpPct: string;
  wtDecrementPct: number;
  activation: string;
  weekType: string | null;
  progression: string | null;
  repsLow: number | null;
};

function toSpec(s: SpecRow): LiftingProgramSpec {
  return {
    week: s.week as 1 | 2 | 3,
    offset: s.offset,
    lift: s.lift,
    increment: s.increment,
    order: s.order,
    sets: s.sets,
    reps: s.reps,
    amrap: s.amrap,
    warmUpPct: s.warmUpPct,
    wtDecrementPct: s.wtDecrementPct,
    activation: s.activation,
    ...(s.weekType !== null && { weekType: s.weekType as 'training' | 'test' | 'deload' }),
    ...(isLiftProgressionType(s.progression) && { progression: s.progression }),
    ...(s.repsLow !== null && { repsLow: s.repsLow }),
  };
}

export class HybridLiftingProgramSpecRepository implements ILiftingProgramSpecRepository {
  // The built-in spec data is user-independent. It defaults to a fresh in-memory
  // repo for standalone construction (tests), but the factory injects a shared
  // instance so the seed map is built once per process rather than per request.
  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
    private readonly inMemory: ILiftingProgramSpecRepository = new InMemoryLiftingProgramSpecRepository(),
  ) {}

  async getProgramSpec(program: string): Promise<LiftingProgramSpec[]> {
    if (UUID_PATTERN.test(program)) {
      return this.getCustomSpec(program);
    }
    return this.inMemory.getProgramSpec(program);
  }

  private async getCustomSpec(id: string): Promise<LiftingProgramSpec[]> {
    // Guard on the owning program's userId — a bare where:{ programId } would let
    // any authenticated user read another user's custom program spec by UUID.
    const rows = await this.prisma.customProgramSpec.findMany({
      where: { programId: id, program: { userId: this.userId } },
      orderBy: [{ week: 'asc' }, { order: 'asc' }],
    });
    return rows.map((s) => toSpec(s));
  }

  /**
   * Idempotently writes spec rows for a custom program (see interface docs).
   * Built-in templates are immutable seed data and are rejected.
   *
   * Classifies each row against a single up-front snapshot read and writes via an
   * `upsert` on the `(programId, week, offset, lift, order)` unique constraint
   * (issue #488), so an identical re-import yields `created: 0` and two concurrent
   * imports racing past the same snapshot cannot both create a duplicate row — the
   * loser updates instead of hitting a unique violation. Shares the classify/dedupe/
   * tally loop and the program-spec classifier with the preview path and the
   * in-memory adapter (issue #532), so preview and commit can never disagree on
   * counts. Named `saveProgramSpec` (vs `importTrainingMaxes`/`importGoals`)
   * intentionally — see the asymmetry note on the port interface.
   */
  async saveProgramSpec(
    program: string,
    rows: LiftingProgramSpec[],
  ): Promise<SaveProgramSpecResult> {
    if (!UUID_PATTERN.test(program)) {
      throw new BadRequestException('Program spec import requires a custom program');
    }

    return runInteractive(
      this.prisma,
      async (tx) => {
        const owner = await tx.customProgram.findFirst({
          where: { id: program, userId: this.userId },
          select: { id: true },
        });
        if (!owner) throw new NotFoundException(`Custom program ${program} not found`);

        // One up-front read instead of a per-row findFirst (#532): the natural-key
        // unique index (#488) makes the upsert race-safe, so the find-then-write per
        // row — and its hand-duplicated where-clause — is no longer needed.
        const existingRows = await tx.customProgramSpec.findMany({
          where: { programId: program },
        });
        const existingByKey = new Map(
          existingRows.map((row) => [programSpecNaturalKey(row), toSpec(row)]),
        );

        // Counts are best-effort under a same-program concurrent-import race: a row the
        // snapshot classified as `create` whose upsert actually updated a row a racing
        // import just inserted still tallies as `created`. The data outcome is correct
        // (the unique index prevents duplicates); only the created/updated split can skew
        // in that rare window. importTrainingMaxes/importGoals share this property.
        return classifyAndCount(
          rows,
          (r) => programSpecNaturalKey(r),
          (r) => programSpecRowKind(r, existingByKey),
          (r) => {
            const data = {
              programId: program,
              week: r.week,
              offset: r.offset,
              lift: r.lift,
              increment: r.increment,
              order: r.order,
              sets: r.sets,
              reps: r.reps,
              amrap: normalizeAmrap(r.amrap),
              warmUpPct: r.warmUpPct,
              wtDecrementPct: r.wtDecrementPct,
              activation: r.activation,
              weekType: r.weekType ?? null,
              // A spec import carries no progression (#1210), so an imported row leaves the
              // stored override alone instead of clearing a backfilled `amrap_gated`.
              ...(r.progression !== undefined && { progression: r.progression }),
              ...(r.repsLow !== undefined && { repsLow: r.repsLow }),
            };
            return tx.customProgramSpec.upsert({
              where: {
                programId_week_offset_lift_order: {
                  programId: program,
                  week: r.week,
                  offset: r.offset,
                  lift: r.lift,
                  order: r.order,
                },
              },
              create: data,
              update: data,
            });
          },
        );
      },
      IMPORT_BATCH_TX_OPTIONS,
    );
  }

  async deleteSpecRows(program: string, naturalKeys: string[]): Promise<void> {
    if (naturalKeys.length === 0 || !UUID_PATTERN.test(program)) return;
    const parsed = naturalKeys.flatMap((k) => {
      const p = parseProgramSpecNaturalKey(k);
      return p ? [p] : [];
    });
    if (parsed.length === 0) return;
    await this.prisma.customProgramSpec.deleteMany({
      where: {
        programId: program,
        OR: parsed.map((p) => ({
          week: p.week,
          offset: p.offset,
          lift: p.lift,
          order: p.order,
        })),
      },
    });
  }
}
