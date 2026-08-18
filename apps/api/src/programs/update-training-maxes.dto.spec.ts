import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { UpdateTrainingMaxesDto } from './update-training-maxes.dto';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const VALID_BODY = {
  maxes: [{ lift: 'Squat', weight: 315, unit: 'lbs' }],
};

function dtoWith(overrides: Record<string, unknown>): UpdateTrainingMaxesDto {
  return plainToInstance(UpdateTrainingMaxesDto, { ...VALID_BODY, ...overrides });
}

function entryWith(overrides: Record<string, unknown>) {
  return { lift: 'Squat', weight: 315, unit: 'lbs', ...overrides };
}

// Returns "<path>.<constraintKey>" pairs, walking nested/array children (e.g.
// "maxes.0.lift.isNotEmpty" for the first array entry's `lift` field) so a test
// asserting on one entry's field cannot pass because a sibling field, or a
// different array index, happened to fail with a same-named rule. Unlike
// create-lift-record.dto.spec.ts's flattener (which only reads top-level
// constraints), this DTO nests via @ValidateNested({ each: true }), so array-index
// and per-entry-field children must be walked recursively.
function flattenErrors(errors: ValidationError[], prefix = ''): string[] {
  const keys: string[] = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) keys.push(...Object.keys(e.constraints).map((k) => `${path}.${k}`));
    if (e.children && e.children.length > 0) keys.push(...flattenErrors(e.children, path));
  }
  return keys;
}

async function flattenConstraintKeys(dto: UpdateTrainingMaxesDto): Promise<string[]> {
  return flattenErrors(await validate(dto, VALIDATION_PIPE_OPTIONS));
}

describe('UpdateTrainingMaxesDto validation', () => {
  // ----- valid-input pass-through -----

  it('accepts a fully-populated well-formed body', async () => {
    const errors = await validate(dtoWith({}), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts multiple entries', async () => {
    const errors = await validate(
      dtoWith({
        maxes: [
          entryWith({}),
          entryWith({ lift: 'Bench Press', weight: 225 }),
        ],
      }),
      VALIDATION_PIPE_OPTIONS,
    );
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty maxes array (no-op update)', async () => {
    const errors = await validate(dtoWith({ maxes: [] }), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a fractional weight', async () => {
    const errors = await validate(dtoWith({ maxes: [entryWith({ weight: 317.5 })] }), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a weight at the sanity ceiling', async () => {
    const errors = await validate(dtoWith({ maxes: [entryWith({ weight: 10000 })] }), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a maxes array at the size ceiling (100 entries)', async () => {
    const maxes = Array.from({ length: 100 }, (_, i) => entryWith({ lift: `Custom Lift ${i}` }));
    const errors = await validate(dtoWith({ maxes }), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  // Regression precedent: CreateLiftRecordDto.lift's #893 review round 3 trim (a
  // different endpoint, identical natural-key-fragmentation failure mode — see
  // TrainingMaxEntryDto.lift's doc comment).
  it('accepts a whitespace-padded lift, trimmed before validation', async () => {
    const dto = dtoWith({ maxes: [entryWith({ lift: '  Squat  ' })] });
    const errors = await validate(dto, VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
    expect(dto.maxes[0].lift).toBe('Squat');
  });

  // ----- invalid-input rejection (issue #897) -----

  it('rejects a missing required maxes field', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.maxes;
    expect(await flattenConstraintKeys(plainToInstance(UpdateTrainingMaxesDto, body))).toContain(
      'maxes.isArray',
    );
  });

  it('rejects a non-array maxes (would otherwise reach body.maxes.map(...) unguarded and 500)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ maxes: 'not-an-array' }))).toContain('maxes.isArray');
  });

  // Regression for issue #897 review: each entry becomes one Prisma upsert inside a
  // single batched transaction (PrismaTrainingMaxRepository.saveTrainingMaxes), so
  // an unbounded array is an unbounded statement count in one transaction.
  it('rejects a maxes array above the size ceiling (101 entries)', async () => {
    const maxes = Array.from({ length: 101 }, (_, i) => entryWith({ lift: `Custom Lift ${i}` }));
    expect(await flattenConstraintKeys(dtoWith({ maxes }))).toContain('maxes.arrayMaxSize');
  });

  it('rejects a missing lift in an entry', async () => {
    const dto = dtoWith({ maxes: [{ weight: 315, unit: 'lbs' }] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.lift.isString');
  });

  // Regression precedent: an empty lift would silently create (or overwrite) a
  // TrainingMax row keyed on an empty string, indistinguishable in the UI from a
  // real lift.
  it('rejects an empty lift in an entry', async () => {
    const dto = dtoWith({ maxes: [entryWith({ lift: '' })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.lift.isNotEmpty');
  });

  it('rejects a whitespace-only lift in an entry (trimmed to empty, same failure mode)', async () => {
    const dto = dtoWith({ maxes: [entryWith({ lift: '   ' })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.lift.isNotEmpty');
  });

  it('rejects a lift above the length ceiling in an entry', async () => {
    const dto = dtoWith({ maxes: [entryWith({ lift: 'x'.repeat(101) })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.lift.maxLength');
  });

  it('rejects a non-numeric weight in an entry', async () => {
    const dto = dtoWith({ maxes: [entryWith({ weight: 'heavy' })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.weight.isNumber');
  });

  // Regression for issue #897 review: matches the client's own validation
  // (TrainingMaxesForm.tsx rejects `n <= 0` with "Enter a positive number") — a
  // training max of 0 is not meaningful and makes every derived working/warm-up
  // weight for that lift compute to 0 with no error anywhere.
  it('rejects a zero weight in an entry', async () => {
    const dto = dtoWith({ maxes: [entryWith({ weight: 0 })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.weight.isPositive');
  });

  it('rejects a negative weight in an entry', async () => {
    const dto = dtoWith({ maxes: [entryWith({ weight: -5 })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.weight.isPositive');
  });

  it('rejects a weight above the sanity ceiling in an entry', async () => {
    const dto = dtoWith({ maxes: [entryWith({ weight: 1e12 })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.weight.max');
  });

  // Regression for issue #897 review: `unit` is validated but never read by
  // TrainingMaxesController (TrainingMax has no unit field; toTrainingMaxResponse
  // always reports 'lbs'), so accepting 'kg' here would silently mislabel — not
  // convert — a 140 kg max as 140 lbs. See TrainingMaxEntryDto.unit's doc comment.
  it('rejects a kg unit (validated-but-unhonored — would silently mislabel, not convert)', async () => {
    const dto = dtoWith({ maxes: [entryWith({ unit: 'kg' })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.unit.isIn');
  });

  it('rejects an unrecognized unit in an entry', async () => {
    const dto = dtoWith({ maxes: [entryWith({ unit: 'stone' })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.unit.isIn');
  });

  it('rejects only the offending entry\'s index, not a sibling valid entry', async () => {
    const dto = dtoWith({
      maxes: [entryWith({}), entryWith({ lift: 'Bench Press', weight: -5 })],
    });
    const keys = await flattenConstraintKeys(dto);
    expect(keys).toContain('maxes.1.weight.isPositive');
    expect(keys.some((k) => k.startsWith('maxes.0.'))).toBe(false);
  });

  it('rejects an unrecognized top-level extra field under forbidNonWhitelisted (matches main.ts pipe config)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ hacked: true }))).toContain('hacked.whitelistValidation');
  });

  it('rejects an unrecognized field within an entry under forbidNonWhitelisted', async () => {
    const dto = dtoWith({ maxes: [entryWith({ hacked: true })] });
    expect(await flattenConstraintKeys(dto)).toContain('maxes.0.hacked.whitelistValidation');
  });
});
