import type { LiftingProgramSpec } from '@lifting-logbook/core';
import { InMemoryLiftingProgramSpecRepository } from './lifting-program-spec.adapter';

const PROGRAM = '11111111-1111-4111-8111-111111111111';

const spec = (lift: string, sets: number, extra: Partial<LiftingProgramSpec> = {}): LiftingProgramSpec => ({
  week: 1,
  offset: 0,
  lift,
  order: 1,
  increment: 5,
  sets,
  reps: 8,
  amrap: false,
  warmUpPct: '0.65',
  wtDecrementPct: 0,
  activation: 'main',
  ...extra,
});

/** Seeds stored rows directly: a custom program's overrides reach the store some other way than an import. */
class SeededRepository extends InMemoryLiftingProgramSpecRepository {
  seed(program: string, rows: LiftingProgramSpec[]): void {
    this.specByProgram.set(program, rows);
  }
}

// The Prisma adapter's upsert never writes the progression columns, since an import never
// carries them (#1210). This adapter must store the same, or a re-import here would behave
// differently from production.
describe('InMemoryLiftingProgramSpecRepository.saveProgramSpec progression (#1210)', () => {
  it("keeps a stored row's override when an import updates the row", async () => {
    const repo = new SeededRepository();
    repo.seed(PROGRAM, [
      spec('Squat', 5, { progression: 'amrap_gated' }),
      spec('Cable Curl', 3, { progression: 'double', repsLow: 6 }),
    ]);

    await repo.saveProgramSpec(PROGRAM, [spec('Squat', 4), spec('Cable Curl', 4)]);

    const rows = await repo.getProgramSpec(PROGRAM);
    expect(rows.map((r) => [r.lift, r.sets, r.progression, r.repsLow])).toEqual([
      ['Squat', 4, 'amrap_gated', undefined],
      ['Cable Curl', 4, 'double', 6],
    ]);
  });

  it('clears a stored repsLow that the imported reps falls below', async () => {
    const repo = new SeededRepository();
    repo.seed(PROGRAM, [spec('Cable Curl', 3, { progression: 'double', repsLow: 6 })]);

    await repo.saveProgramSpec(PROGRAM, [spec('Cable Curl', 3, { reps: 5 })]);

    const [row] = await repo.getProgramSpec(PROGRAM);
    expect([row?.reps, row?.progression, row?.repsLow]).toEqual([5, 'double', undefined]);
  });

  it("never stores an imported row's own progression fields", async () => {
    const repo = new SeededRepository();
    repo.seed(PROGRAM, [spec('Squat', 5, { progression: 'amrap_gated' })]);

    await repo.saveProgramSpec(PROGRAM, [
      spec('Squat', 4, { progression: 'linear', repsLow: 3 }),
      spec('Deadlift', 5, { progression: 'linear', repsLow: 3 }),
    ]);

    const rows = await repo.getProgramSpec(PROGRAM);
    expect(rows.map((r) => [r.lift, r.progression, r.repsLow])).toEqual([
      ['Squat', 'amrap_gated', undefined],
      ['Deadlift', undefined, undefined],
    ]);
  });
});
