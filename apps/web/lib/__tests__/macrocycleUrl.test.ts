import { ApiClientError } from '@lifting-logbook/api-client';
import {
  movedMacrocycleNum,
  movedWorkoutPath,
  withMacrocycleNum,
  writeFailureMessage,
} from '../macrocycleUrl';

const moved = (num: unknown) =>
  new ApiClientError('moved', 409, 'macrocycle-moved', { code: 'macrocycle-moved', macrocycleNum: num });

describe('withMacrocycleNum', () => {
  it('replaces only the leading macrocycle segment', () => {
    expect(withMacrocycleNum('/macrocycle/2/workout/2/detail', 3)).toBe('/macrocycle/3/workout/2/detail');
    expect(withMacrocycleNum('/history/macrocycle/2', 3)).toBe('/history/macrocycle/2');
  });
});

describe('movedWorkoutPath', () => {
  it('is null when the URL and the workout agree, so a redirect cannot loop', () => {
    expect(movedWorkoutPath('/macrocycle/2/workout/4', 2, 2)).toBeNull();
  });

  it('points at the number the workout was read from', () => {
    expect(movedWorkoutPath('/macrocycle/2/workout/4/timer', 2, 3)).toBe('/macrocycle/3/workout/4/timer');
  });
});

describe('movedMacrocycleNum', () => {
  it('reads the new number off a macrocycle-moved 409', () => {
    expect(movedMacrocycleNum(moved(3))).toBe(3);
  });

  it('is null for any other error, or a moved body with no usable number', () => {
    expect(movedMacrocycleNum(moved('3'))).toBeNull();
    expect(movedMacrocycleNum(new ApiClientError('busy', 409, 'import-in-progress'))).toBeNull();
    expect(movedMacrocycleNum(new ApiClientError('dup', 409))).toBeNull();
    expect(movedMacrocycleNum(new Error('network'))).toBeNull();
  });
});

describe('writeFailureMessage', () => {
  it('asks for a retry while an import holds the lock', () => {
    expect(writeFailureMessage(new ApiClientError('busy', 409, 'import-in-progress'), 'Failed.')).toMatch(/import/i);
  });

  it('falls back for anything else', () => {
    expect(writeFailureMessage(new ApiClientError('dup', 409), 'Failed.')).toBe('Failed.');
    expect(writeFailureMessage(new Error('x'), 'Failed.')).toBe('Failed.');
  });
});
