import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLiftRecordDto } from './create-lift-record.dto';

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

async function flattenConstraintKeys(dto: CreateLiftRecordDto): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const keys: string[] = [];
  for (const e of errors) {
    if (e.constraints) keys.push(...Object.keys(e.constraints));
  }
  return keys;
}

describe('CreateLiftRecordDto validation', () => {
  // ----- valid-input pass-through -----

  it('accepts a fully-populated well-formed body', async () => {
    const errors = await validate(dtoWith({}), { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it('accepts a body omitting the optional date and notes fields', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.date;
    delete body.notes;
    const errors = await validate(plainToInstance(CreateLiftRecordDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts a body omitting the unused program field (the route :program param is authoritative, not every caller sends it)', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.program;
    const errors = await validate(plainToInstance(CreateLiftRecordDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
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

  // ----- invalid-input rejection (issue #893) -----

  it('rejects a non-date-string date instead of reaching new Date() as Invalid Date', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: 'not-a-date' }))).toContain('isDateString');
  });

  it('rejects an empty-string date', async () => {
    expect(await flattenConstraintKeys(dtoWith({ date: '' }))).toContain('isDateString');
  });

  it('rejects a missing required lift field', async () => {
    const body = { ...VALID_BODY } as Record<string, unknown>;
    delete body.lift;
    const keys = await flattenConstraintKeys(plainToInstance(CreateLiftRecordDto, body));
    expect(keys).toContain('isString');
  });

  it('rejects a non-integer cycleNum', async () => {
    expect(await flattenConstraintKeys(dtoWith({ cycleNum: 1.5 }))).toContain('isInt');
  });

  it('rejects a cycleNum below 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ cycleNum: 0 }))).toContain('min');
  });

  it('rejects a non-numeric weight', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: 'heavy' }))).toContain('isNumber');
  });

  it('rejects a negative weight', async () => {
    expect(await flattenConstraintKeys(dtoWith({ weight: -5 }))).toContain('min');
  });

  it('rejects a non-integer reps', async () => {
    expect(await flattenConstraintKeys(dtoWith({ reps: 5.5 }))).toContain('isInt');
  });

  it('rejects reps below 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ reps: 0 }))).toContain('min');
  });

  it('rejects a setNum below 1', async () => {
    expect(await flattenConstraintKeys(dtoWith({ setNum: 0 }))).toContain('min');
  });

  it('rejects a non-integer workoutNum', async () => {
    expect(await flattenConstraintKeys(dtoWith({ workoutNum: 1.5 }))).toContain('isInt');
  });

  it('rejects an unrecognized extra field under forbidNonWhitelisted (matches main.ts pipe config)', async () => {
    expect(await flattenConstraintKeys(dtoWith({ hacked: true }))).toContain('whitelistValidation');
  });
});
