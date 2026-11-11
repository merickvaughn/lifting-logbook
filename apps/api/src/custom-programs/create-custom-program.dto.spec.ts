import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCustomProgramDto } from './create-custom-program.dto';

const VALID_SPEC_ROW = {
  week: 1,
  offset: 0,
  lift: 'Bench Press',
  increment: 5,
  order: 1,
  sets: 3,
  reps: 5,
  amrap: false,
  warmUpPct: '0.4,0.5,0.6',
  wtDecrementPct: 0.1,
  activation: 'none',
};

function dtoWith(specOverride: Record<string, unknown>): CreateCustomProgramDto {
  return plainToInstance(CreateCustomProgramDto, {
    name: 'My Program',
    specs: [{ ...VALID_SPEC_ROW, ...specOverride }],
  });
}

function dtoWithSpecs(overrides: Record<string, unknown>[]): CreateCustomProgramDto {
  return plainToInstance(CreateCustomProgramDto, {
    name: 'My Program',
    specs: overrides.map((o) => ({ ...VALID_SPEC_ROW, ...o })),
  });
}

async function flattenConstraintKeys(dto: CreateCustomProgramDto): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true });
  const keys: string[] = [];
  const walk = (errs: typeof errors): void => {
    for (const e of errs) {
      if (e.constraints) keys.push(...Object.keys(e.constraints));
      if (e.children?.length) walk(e.children);
    }
  };
  walk(errors);
  return keys;
}

describe('CreateCustomProgramDto validation', () => {
  it('accepts a well-formed program', async () => {
    const errors = await validate(dtoWith({}), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('rejects a zero increment (would make MROUND divide by zero)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ increment: 0 }))).toContain('isPositive');
  });

  it('rejects a negative increment', async () => {
    expect(await flattenConstraintKeys(dtoWith({ increment: -5 }))).toContain('isPositive');
  });

  it('rejects a wtDecrementPct above 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ wtDecrementPct: 1.5 }))).toContain('max');
  });

  it('rejects a negative wtDecrementPct', async () => {
    expect(await flattenConstraintKeys(dtoWith({ wtDecrementPct: -0.1 }))).toContain('min');
  });

  it('rejects a wtDecrementPct that drives the final set negative (cross-field)', async () => {
    // 0.6 passes @Max(1) but 1 - (3-1)*0.6 = -0.2 → final set negative.
    expect(
      await flattenConstraintKeys(dtoWith({ wtDecrementPct: 0.6, sets: 3 })),
    ).toContain('wtDecrementWithinSetBound');
  });

  it('accepts the boundary where the final set is exactly 0', async () => {
    // 1 - (3-1)*0.5 = 0 → allowed (mirrors the core guard).
    const errors = await validate(dtoWith({ wtDecrementPct: 0.5, sets: 3 }), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  // ----- Workout-day grouping (issue #751): offset/order carry the day structure -----

  it('accepts an offset greater than 0 (an exercise on a later workout day)', async () => {
    const errors = await validate(dtoWith({ offset: 2 }), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('accepts the same lift on two different offsets (trained on multiple days)', async () => {
    const dto = dtoWithSpecs([
      { offset: 0, lift: 'Squat', order: 1 },
      { offset: 2, lift: 'Squat', order: 1 },
    ]);
    const errors = await validate(dto, { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('accepts the same lift twice within one day (distinct order)', async () => {
    const dto = dtoWithSpecs([
      { offset: 0, lift: 'Squat', order: 1 },
      { offset: 0, lift: 'Squat', order: 2 },
    ]);
    const errors = await validate(dto, { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('rejects an order below 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ order: 0 }))).toContain('min');
  });

  it('rejects a negative offset', async () => {
    expect(await flattenConstraintKeys(dtoWith({ offset: -1 }))).toContain('min');
  });

  // #1210: a row's progression override and the bottom of its rep range.
  it('accepts a row progression and a repsLow at or below reps', async () => {
    expect(await validate(dtoWith({ progression: 'double', repsLow: 5 }), { whitelist: true })).toHaveLength(0);
  });

  it.each(['rpe', 'wave'])('rejects the row progression %s', async (progression) => {
    expect(await flattenConstraintKeys(dtoWith({ progression }))).toContain('isIn');
  });

  it('rejects a repsLow above the row reps', async () => {
    expect(await flattenConstraintKeys(dtoWith({ reps: 8, repsLow: 9 }))).toContain('isAtMostSibling');
  });
});
