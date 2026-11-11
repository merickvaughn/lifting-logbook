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

describe('InMemoryLiftingProgramSpecRepository.saveProgramSpec', () => {
  // The Prisma adapter's upsert leaves the progression columns alone, since an import never
  // carries them (#1210); this adapter must agree, or a re-import here clears `amrap_gated`.
  it("keeps a stored row's progression override when an import updates the row", async () => {
    const repo = new InMemoryLiftingProgramSpecRepository();
    await repo.saveProgramSpec(PROGRAM, [
      spec('Squat', 5, { progression: 'amrap_gated' }),
      spec('Cable Curl', 3, { progression: 'double', repsLow: 6 }),
    ]);

    await repo.saveProgramSpec(PROGRAM, [spec('Squat', 4), spec('Cable Curl', 4), spec('Deadlift', 5)]);

    const rows = await repo.getProgramSpec(PROGRAM);
    expect(rows.map((r) => [r.lift, r.sets, r.progression, r.repsLow])).toEqual([
      ['Squat', 4, 'amrap_gated', undefined],
      ['Cable Curl', 4, 'double', 6],
      ['Deadlift', 5, undefined, undefined],
    ]);
  });
});
