import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateLiftRecordDto } from './update-lift-record.dto';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

// See create-lift-record.dto.spec.ts for why this tracks "<property>.<constraintKey>"
// rather than a bare constraint key.
async function flattenConstraintKeys(dto: UpdateLiftRecordDto): Promise<string[]> {
  const errors = await validate(dto, VALIDATION_PIPE_OPTIONS);
  const keys: string[] = [];
  for (const e of errors) {
    if (e.constraints) keys.push(...Object.keys(e.constraints).map((k) => `${e.property}.${k}`));
  }
  return keys;
}

describe('UpdateLiftRecordDto validation', () => {
  // ----- valid-input pass-through -----

  it('accepts a well-formed partial update (weight + reps)', async () => {
    const dto = plainToInstance(UpdateLiftRecordDto, { weight: 185, reps: 4 });
    const errors = await validate(dto, VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty body (all fields are optional)', async () => {
    const dto = plainToInstance(UpdateLiftRecordDto, {});
    const errors = await validate(dto, VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a notes-only update', async () => {
    const dto = plainToInstance(UpdateLiftRecordDto, { notes: 'new notes' });
    const errors = await validate(dto, VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  // ----- invalid-input rejection (issue #893) -----

  it('rejects a negative weight', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { weight: -10 }));
    expect(keys).toContain('weight.min');
  });

  it('rejects a non-numeric weight', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { weight: 'heavy' }));
    expect(keys).toContain('weight.isNumber');
  });

  // Regression for #893's review round 2 (same reasoning as CreateLiftRecordDto): a
  // generous but finite ceiling, matching the sibling create-side DTO exactly since
  // both reach the same weight/reps columns (this one via PATCH).
  it('rejects a weight above the sanity ceiling', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { weight: 1e12 }));
    expect(keys).toContain('weight.max');
  });

  it('rejects reps below 1', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { reps: 0 }));
    expect(keys).toContain('reps.min');
  });

  it('rejects a non-integer reps', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { reps: 4.5 }));
    expect(keys).toContain('reps.isInt');
  });

  // Regression for #893's review round 2: reps is a Postgres Int (32-bit) column —
  // verified live against real Postgres that an unbounded value 500s at the database.
  it('rejects reps above the int32-safe ceiling', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { reps: 3_000_000_000 }));
    expect(keys).toContain('reps.max');
  });

  it('rejects a non-string notes', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { notes: 123 }));
    expect(keys).toContain('notes.isString');
  });

  it('rejects notes above the length ceiling', async () => {
    const keys = await flattenConstraintKeys(
      plainToInstance(UpdateLiftRecordDto, { notes: 'x'.repeat(501) }),
    );
    expect(keys).toContain('notes.maxLength');
  });

  it('rejects an unrecognized extra field under forbidNonWhitelisted (matches main.ts pipe config)', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { hacked: true }));
    expect(keys).toContain('hacked.whitelistValidation');
  });

  // Regression for #893's review round 3: @IsOptional() skips validation for both
  // `undefined` (absent) *and* `null`, but only absence is a legitimate "leave
  // unchanged" signal for a PATCH against non-nullable columns. Before switching to
  // @ValidateIf, { weight: null } passed validation with zero errors and then
  // crashed Prisma with an unhandled 500 (verified against real Postgres — the
  // in-memory adapter's `?? current.weight` fallback silently masks this).
  it('rejects an explicit null weight (only absence, not null, means "leave unchanged")', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { weight: null }));
    expect(keys).toContain('weight.isNumber');
  });

  it('rejects an explicit null reps', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { reps: null }));
    expect(keys).toContain('reps.isInt');
  });

  it('rejects an explicit null notes', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { notes: null }));
    expect(keys).toContain('notes.isString');
  });
});
