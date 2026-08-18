import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLiftRecordDto } from './create-lift-record.dto';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const VALID_BODY = {
  program: '5-3-1',
  cycleNum: 4,
  workoutNum: 1,
  date: '2026-04-20',
  lift: 'Bench Press',
  setNum: 1,
  weight: 180,
  reps: 5,
  notes: 'felt good',
};

function dtoWith(overrides: Record<string, unknown>): CreateLiftRecordDto {
  return plainToInstance(CreateLiftRecordDto, { ...VALID_BODY, ...overrides });
}

// Returns "<property>.<constraintKey>" pairs (e.g. "date.isDateString") rather than
// bare constraint keys, so a test asserting on one field's rule cannot pass because a
// *different* field happened to fail with a same-named rule (e.g. once both `weight`
// and `reps` have a `min` constraint, a bare 'min' match no longer pins down which
// field actually failed).
async function flattenConstraintKeys(dto: CreateLiftRecordDto): Promise<string[]> {
  const errors = await validate(dto, VALIDATION_PIPE_OPTIONS);
  const keys: string[] = [];
  for (const e of errors) {
    if (e.constraints) keys.push(...Object.keys(e.constraints).map((k) => `${e.property}.${k}`));
  }
  return keys;
}

describe('CreateLiftRecordDto validation', () => {
  // ----- valid-input pass-through -----

  it('accepts a fully-populated well-formed body', async () => {
    const errors = await validate(dtoWith({}), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a body omitting the optional date and notes fields', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.date;
    delete body.notes;
    const errors = await validate(plainToInstance(CreateLiftRecordDto, body), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a body omitting the unused program field (the route :program param is authoritative, not every caller sends it)', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.program;
    const errors = await validate(plainToInstance(CreateLiftRecordDto, body), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a fractional weight (fractional plate loads are valid)', async () => {
    const errors = await validate(dtoWith({ weight: 182.5 }), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('accepts a zero weight (bodyweight-only exercises)', async () => {
    const errors = await validate(dtoWith({ weight: 0 }), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('accepts a full ISO 8601 date-time for date', async () => {
    const errors = await validate(dtoWith({ date: '2026-04-20T10:30:00Z' }), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  // ----- invalid-input rejection (issue #893) -----

  it('rejects a non-date-string date instead of reaching new Date() as Invalid Date', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: 'not-a-date' }))).toContain('date.matches');
  });

  it('rejects an empty-string date', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '' }))).toContain('date.matches');
  });

  // Regression for #893's review round 2: validator.js's isISO8601, even with
  // { strict: true, strictSeparator: true }, still accepts the ISO 8601 week-date
  // and ordinal-date forms — which new Date(...) either can't parse (Invalid Date,
  // "2026-W05") or silently misparses as an unrelated day ("2026-001" -> Jan 1). The
  // @Matches decorator is what actually closes this gap; @IsDateString alone does not.
  it('rejects an ISO 8601 week-date (new Date() cannot parse it — would 500 downstream)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '2026-W05' }))).toContain('date.matches');
  });

  it('rejects an ISO 8601 ordinal-date (new Date() silently misparses it to Jan 1)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '2026-001' }))).toContain('date.matches');
  });

  // Regression for #893's review round 2: a shape-valid but nonexistent calendar
  // date. Non-strict @IsDateString accepts this and new Date() silently rolls it
  // over to a different day (2026-02-30 -> 2026-03-02) — verified live against real
  // Postgres before the { strict: true, strictSeparator: true } fix. @Matches alone
  // does not catch this (the shape is correct); @IsDateString's strict option does.
  it('rejects a shape-valid but nonexistent calendar date (would silently roll over)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '2026-02-30' }))).toContain('date.isDateString');
  });

  it('rejects a basic-format date with no separators (new Date() cannot parse it)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '20260501' }))).toContain('date.matches');
  });

  it('rejects a missing required lift field', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.lift;
    const keys = await flattenConstraintKeys(plainToInstance(CreateLiftRecordDto, body));
    expect(keys).toContain('lift.isString');
  });

  // Regression for #893's review round 2: an empty lift produces an id whose parser
  // (parseLiftRecordId, apps/api/src/adapters/prisma/lift-record.repository.ts)
  // rejects an empty lift segment and returns null — the record is written but
  // permanently unreachable by a later PATCH, verified live against real Postgres.
  it('rejects an empty lift (would create a record unreachable by PATCH)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ lift: '' }))).toContain('lift.isNotEmpty');
  });

  it('rejects a non-integer cycleNum', async () => {
    expect(await flattenConstraintKeys(dtoWith({ cycleNum: 1.5 }))).toContain('cycleNum.isInt');
  });

  it('rejects a cycleNum below 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ cycleNum: 0 }))).toContain('cycleNum.min');
  });

  it('rejects a non-numeric weight', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: 'heavy' }))).toContain('weight.isNumber');
  });

  it('rejects a negative weight', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: -5 }))).toContain('weight.min');
  });

  it('rejects a non-integer reps', async () => {
    expect(await flattenConstraintKeys(dtoWith({ reps: 5.5 }))).toContain('reps.isInt');
  });

  it('rejects reps below 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ reps: 0 }))).toContain('reps.min');
  });

  // Regression for #893's review round 2: reps is a Postgres Int (32-bit) column —
  // an unbounded value passes validation and fails at the database as an unhandled
  // 500, verified live against real Postgres (the in-memory test adapter has no
  // column-width constraint and does not reproduce this).
  it('rejects reps above the int32-safe ceiling (would 500 at the database)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ reps: 3_000_000_000 }))).toContain('reps.max');
  });

  it('rejects a weight above the sanity ceiling', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: 1e12 }))).toContain('weight.max');
  });

  it('rejects notes above the length ceiling', async () => {
    expect(await flattenConstraintKeys(dtoWith({ notes: 'x'.repeat(501) }))).toContain('notes.maxLength');
  });

  it('accepts notes at the length ceiling', async () => {
    const errors = await validate(dtoWith({ notes: 'x'.repeat(500) }), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('rejects a setNum below 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ setNum: 0 }))).toContain('setNum.min');
  });

  it('rejects a non-integer workoutNum', async () => {
    expect(await flattenConstraintKeys(dtoWith({ workoutNum: 1.5 }))).toContain('workoutNum.isInt');
  });

  it('rejects a cycleNum above the sanity ceiling (obvious client bug, not a legitimate program length)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ cycleNum: 40000000 }))).toContain('cycleNum.max');
  });

  it('rejects a workoutNum above the sanity ceiling', async () => {
    expect(await flattenConstraintKeys(dtoWith({ workoutNum: 40000000 }))).toContain('workoutNum.max');
  });

  it('rejects a setNum above the sanity ceiling', async () => {
    expect(await flattenConstraintKeys(dtoWith({ setNum: 40000000 }))).toContain('setNum.max');
  });

  it('accepts a cycleNum at the sanity ceiling', async () => {
    const errors = await validate(dtoWith({ cycleNum: 1000 }), { whitelist: true });
    expect(errors).toHaveLength(0);
  });

  it('rejects an unrecognized extra field under forbidNonWhitelisted (matches main.ts pipe config)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ hacked: true }))).toContain('hacked.whitelistValidation');
  });
});
