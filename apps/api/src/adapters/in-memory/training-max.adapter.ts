import { TrainingMax, classifyAndCount, latestTrainingMaxFirst, trainingMaxRowKind } from '@lifting-logbook/core';
import { ImportWriteResult } from '@lifting-logbook/types';
import { ITrainingMaxRepository } from '../../ports/ITrainingMaxRepository';
import { SEED_PROGRAM, seedTrainingMaxes } from './fixtures';

export class InMemoryTrainingMaxRepository implements ITrainingMaxRepository {
  private maxesByProgram: Map<string, TrainingMax[]>;

  constructor(preSeed = false) {
    this.maxesByProgram = preSeed
      ? new Map([[SEED_PROGRAM, seedTrainingMaxes()]])
      : new Map();
  }

  allByProgram(): (TrainingMax & { program: string })[] {
    return [...this.maxesByProgram].flatMap(([program, maxes]) =>
      maxes.map((max) => ({ ...max, program })),
    );
  }

  async getTrainingMaxes(program: string): Promise<TrainingMax[]> {
    return this.maxesByProgram.get(program) ?? [];
  }

  async saveTrainingMaxes(program: string, maxes: TrainingMax[]): Promise<void> {
    // Upsert-by-lift, mirroring the Prisma adapter's per-lift `upsert`: incoming
    // lifts overwrite, omitted lifts are preserved. A prior full-replace here
    // diverged from production and let a partial Smart Import (#477) silently
    // wipe training maxes for lifts not present in the uploaded file.
    const byLift = new Map((this.maxesByProgram.get(program) ?? []).map((m) => [m.lift, m]));
    for (const m of maxes) byLift.set(m.lift, m);
    this.maxesByProgram.set(program, [...byLift.values()]);
  }

  async importTrainingMaxes(
    program: string,
    maxes: TrainingMax[],
  ): Promise<ImportWriteResult> {
    const existing = this.maxesByProgram.get(program) ?? [];
    const existingByLift = new Map(existing.map((m) => [m.lift, m.weight]));
    const byLift = new Map(existing.map((m) => [m.lift, m]));

    // Shared classify/dedupe/tally loop (#532) so this adapter's counts match the
    // Prisma adapter's and the preview path's for the same input.
    const result = await classifyAndCount(
      latestTrainingMaxFirst(maxes),
      (m) => m.lift,
      (m) => trainingMaxRowKind(m, existingByLift),
      (m) => {
        byLift.set(m.lift, m);
      },
    );

    this.maxesByProgram.set(program, [...byLift.values()]);
    return result;
  }

  async deleteTrainingMaxes(program: string, lifts: string[]): Promise<void> {
    if (lifts.length === 0) return;
    const liftSet = new Set(lifts);
    const existing = this.maxesByProgram.get(program) ?? [];
    this.maxesByProgram.set(program, existing.filter((m) => !liftSet.has(m.lift)));
  }

  async deleteAllTrainingMaxes(program: string): Promise<void> {
    this.maxesByProgram.delete(program);
  }

  /** Each program's dismissed lift ids, in the order they were dismissed. */
  private readonly dismissals = new Map<string, Set<string>>();

  /** Every dismissal, for Download My Data. */
  allDismissals(): { program: string; liftId: string }[] {
    return [...this.dismissals].flatMap(([program, ids]) => [...ids].map((liftId) => ({ program, liftId })));
  }

  async getMissingMaxDismissals(program: string): Promise<string[]> {
    return [...(this.dismissals.get(program) ?? [])];
  }

  async dismissMissingMax(program: string, liftId: string): Promise<void> {
    const ids = this.dismissals.get(program) ?? new Set<string>();
    ids.add(liftId);
    this.dismissals.set(program, ids);
  }

  async undismissMissingMax(program: string, liftId: string): Promise<void> {
    this.dismissals.get(program)?.delete(liftId);
  }
}
