import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RecordBodyWeightDto } from './record-body-weight.dto';
import { VALIDATION_PIPE_OPTIONS } from '../validation-pipe.config';

const VALID_BODY = {
  date: '2026-04-20',
  weight: 180,
  unit: 'lbs',
};

function dtoWith(overrides: Record<string, unknown>): RecordBodyWeightDto {
  return plainToInstance(RecordBodyWeightDto, { ...VALID_BODY, ...overrides });
}

// Returns "<property>.<constraintKey>" pairs (e.g. "date.isDateString") rather than
// bare constraint keys, so a test asserting on one field's rule cannot pass because a
// *different* field happened to fail with a same-named rule.
async function flattenConstraintKeys(dto: RecordBodyWeightDto): Promise<string[]> {
  const errors = await validate(dto, VALIDATION_PIPE_OPTIONS);
  const keys: string[] = [];
  for (const e of errors) {
    if (e.constraints) keys.push(...Object.keys(e.constraints).map((k) => `${e.property}.${k}`));
  }
  return keys;
}

describe('RecordBodyWeightDto validation', () => {
  // ----- valid-input pass-through -----

  it('accepts a fully-populated well-formed body', async () => {
    const errors = await validate(dtoWith({}), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a fractional weight', async () => {
    const errors = await validate(dtoWith({ weight: 182.5 }), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a kg unit', async () => {
    const errors = await validate(dtoWith({ unit: 'kg' }), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  it('accepts a weight at the sanity ceiling', async () => {
    const errors = await validate(dtoWith({ weight: 10000 }), VALIDATION_PIPE_OPTIONS);
    expect(errors).toHaveLength(0);
  });

  // ----- invalid-input rejection (issue #897) -----

  it('rejects a missing required date', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.date;
    const keys = await flattenConstraintKeys(plainToInstance(RecordBodyWeightDto, body));
    expect(keys).toContain('date.matches');
  });

  it('rejects a non-date-string date instead of reaching new Date() as Invalid Date', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: 'not-a-date' }))).toContain('date.matches');
  });

  // Same class of bug #893's review round 3 fixed for CreateLiftRecordDto.date: the
  // controller's `new Date(body.date)` parses a date-time string differently than a
  // bare date (UTC vs. server-local, depending on whether an offset is present),
  // which can silently shift the stored calendar day. date is restricted to a bare
  // YYYY-MM-DD so no real caller (which only ever sends a bare date) is affected.
  it('rejects a date-time (bare YYYY-MM-DD only, to avoid timezone-dependent day-shift bugs)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '2026-04-20T10:30:00Z' }))).toContain('date.matches');
  });

  it('rejects an ISO 8601 week-date (new Date() cannot parse it — would 500 downstream)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '2026-W05' }))).toContain('date.matches');
  });

  it('rejects an ISO 8601 ordinal-date (new Date() silently misparses it to Jan 1)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '2026-001' }))).toContain('date.matches');
  });

  it('rejects a shape-valid but nonexistent calendar date (would silently roll over)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '2026-02-30' }))).toContain('date.isDateString');
  });

  it('rejects a basic-format date with no separators (new Date() cannot parse it)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '20260420' }))).toContain('date.matches');
  });

  // Regression for issue #897 review: matches the client's own validation
  // (WorkoutLogger.tsx's handleBodyWeightSubmit rejects `weight <= 0` before ever
  // calling this endpoint) — a body-weight observation of 0 is not meaningful the
  // way a lift's *added* weight of 0 is (bodyweight-only exercises).
  it('rejects a zero weight', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: 0 }))).toContain('weight.isPositive');
  });

  it('rejects a missing required weight', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.weight;
    const keys = await flattenConstraintKeys(plainToInstance(RecordBodyWeightDto, body));
    expect(keys).toContain('weight.isNumber');
  });

  it('rejects a non-numeric weight', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: 'heavy' }))).toContain('weight.isNumber');
  });

  it('rejects a negative weight', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: -5 }))).toContain('weight.isPositive');
  });

  it('rejects a weight above the sanity ceiling', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: 1e12 }))).toContain('weight.max');
  });

  it('rejects a missing required unit', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.unit;
    const keys = await flattenConstraintKeys(plainToInstance(RecordBodyWeightDto, body));
    expect(keys).toContain('unit.isIn');
  });

  it('rejects an unrecognized unit', async () => {
    expect(await flattenConstraintKeys(dtoWith({ unit: 'stone' }))).toContain('unit.isIn');
  });

  it('rejects an unrecognized extra field under forbidNonWhitelisted (matches main.ts pipe config)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ hacked: true }))).toContain('hacked.whitelistValidation');
  });
});
