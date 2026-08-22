import type { ImportError } from '@lifting-logbook/types';
import { isLiftNameError } from './import-error-codes';

function err(overrides: Partial<ImportError> = {}): ImportError {
  return { row: 1, code: 'WEIGHT_INVALID', message: 'weight is not a number', ...overrides };
}

describe('isLiftNameError', () => {
  it('is true for UNRECOGNIZED_LIFT', () => {
    expect(isLiftNameError(err({ code: 'UNRECOGNIZED_LIFT', field: 'lift' }))).toBe(true);
  });

  it('is true for LIFT_EMPTY', () => {
    expect(isLiftNameError(err({ code: 'LIFT_EMPTY', field: 'lift' }))).toBe(true);
  });

  it('is false for every other code', () => {
    expect(isLiftNameError(err({ code: 'WEIGHT_INVALID', field: 'weight' }))).toBe(false);
    expect(isLiftNameError(err({ code: 'DATE_INVALID', field: 'date' }))).toBe(false);
    expect(isLiftNameError(err({ code: 'ROW_LIMIT_EXCEEDED' }))).toBe(false);
  });
});
