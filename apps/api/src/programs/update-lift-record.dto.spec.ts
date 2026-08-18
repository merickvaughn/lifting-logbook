import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateLiftRecordDto } from './update-lift-record.dto';

async function flattenConstraintKeys(dto: UpdateLiftRecordDto): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const keys: string[] = [];
  for (const e of errors) {
    if (e.constraints) keys.push(...Object.keys(e.constraints));
  }
  return keys;
}

describe('UpdateLiftRecordDto validation', () => {
  // ----- valid-input pass-through -----

  it('accepts a well-formed partial update (weight + reps)', async () => {
    const dto = plainToInstance(UpdateLiftRecordDto, { weight: 185, reps: 4 });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty body (all fields are optional)', async () => {
    const dto = plainToInstance(UpdateLiftRecordDto, {});
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  it('accepts a notes-only update', async () => {
    const dto = plainToInstance(UpdateLiftRecordDto, { notes: 'new notes' });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  // ----- invalid-input rejection (issue #893) -----

  it('rejects a negative weight', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { weight: -10 }));
    expect(keys).toContain('min');
  });

  it('rejects a non-numeric weight', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { weight: 'heavy' }));
    expect(keys).toContain('isNumber');
  });

  it('rejects reps below 1', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { reps: 0 }));
    expect(keys).toContain('min');
  });

  it('rejects a non-integer reps', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { reps: 4.5 }));
    expect(keys).toContain('isInt');
  });

  it('rejects a non-string notes', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { notes: 123 }));
    expect(keys).toContain('isString');
  });

  it('rejects an unrecognized extra field under forbidNonWhitelisted (matches main.ts pipe config)', async () => {
    const keys = await flattenConstraintKeys(plainToInstance(UpdateLiftRecordDto, { hacked: true }));
    expect(keys).toContain('whitelistValidation');
  });
});
