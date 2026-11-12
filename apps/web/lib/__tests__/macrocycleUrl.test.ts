import { ApiClientError } from '@lifting-logbook/api-client';
import {
  browserNavigation,
  followMovedMacrocycle,
  movedMacrocycleNum,
  movedWorkoutPath,
  withMacrocycleId,
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

describe('withMacrocycleId', () => {
  it('adds the id to a link, after any query it already has', () => {
    expect(withMacrocycleId('/pick?action=add', 'mc a')).toBe('/pick?action=add&macrocycleId=mc%20a');
    expect(withMacrocycleId('/pick', 'mc-a')).toBe('/pick?macrocycleId=mc-a');
  });

  it('leaves a link alone when there is no id', () => {
    expect(withMacrocycleId('/pick?action=add', undefined)).toBe('/pick?action=add');
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

describe('followMovedMacrocycle', () => {
  let assign: jest.SpyInstance<void, [string]>;
  beforeEach(() => {
    assign = jest.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
    window.history.pushState({}, '', '/macrocycle/1/workout/2/detail?from=history');
  });
  afterEach(() => {
    assign.mockRestore();
    window.history.pushState({}, '', '/');
    window.sessionStorage.clear();
    jest.useRealTimers();
  });

  it('reloads at the new number for macrocycle-moved', () => {
    expect(followMovedMacrocycle(moved(3))).toBe(true);
    expect(assign).toHaveBeenCalledWith('/macrocycle/3/workout/2/detail?from=history');
  });

  it('reloads the page as it is when the API asks for the macrocycle id (#1200)', () => {
    const err = new ApiClientError('Reload the page and try again.', 400, 'macrocycle-id-required');
    expect(followMovedMacrocycle(err)).toBe(true);
    expect(assign).toHaveBeenCalledWith('/macrocycle/1/workout/2/detail?from=history');
  });

  it('leaves a second missing id on the same page within a minute to the caller, which shows the message (#1200)', () => {
    jest.useFakeTimers({ now: new Date('2026-11-12T10:00:00Z') });
    const err = new ApiClientError('Reload the page and try again.', 400, 'macrocycle-id-required');
    expect(followMovedMacrocycle(err)).toBe(true);

    jest.setSystemTime(new Date('2026-11-12T10:00:30Z'));
    expect(followMovedMacrocycle(err)).toBe(false);
    expect(writeFailureMessage(err, 'Failed.')).toBe('Reload the page and try again.');
    expect(assign).toHaveBeenCalledTimes(1);

    // Past the minute, or on another page, it reloads again.
    jest.setSystemTime(new Date('2026-11-12T10:01:01Z'));
    expect(followMovedMacrocycle(err)).toBe(true);
    window.history.pushState({}, '', '/macrocycle/1/workout/3/detail');
    expect(followMovedMacrocycle(err)).toBe(true);
    expect(assign).toHaveBeenCalledTimes(3);
  });

  it('shows the message rather than reloading when session storage is unavailable', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(followMovedMacrocycle(new ApiClientError('Reload.', 400, 'macrocycle-id-required'))).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
    }
  });

  it('leaves any other error to the caller, without reloading', () => {
    expect(followMovedMacrocycle(new ApiClientError('bad', 400, 'validation'))).toBe(false);
    expect(followMovedMacrocycle(new ApiClientError('busy', 409, 'import-in-progress'))).toBe(false);
    expect(followMovedMacrocycle(new Error('network'))).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('writeFailureMessage', () => {
  it("shows the API's message while an import holds the lock", () => {
    const msg = 'An import is changing your macrocycles. Try again in a moment.';
    expect(writeFailureMessage(new ApiClientError(msg, 409, 'import-in-progress'), 'Failed.')).toBe(msg);
  });

  it("shows the API's message for a macrocycle that is no longer current", () => {
    const msg = 'This page is for macrocycle 1, which is no longer the current one.';
    expect(writeFailureMessage(new ApiClientError(msg, 409, 'macrocycle-not-current'), 'Failed.')).toBe(msg);
  });

  it("shows the API's reload message for a page whose macrocycle no longer exists", () => {
    const msg = "This page's macrocycle no longer exists. Reload the page to see the current one.";
    expect(writeFailureMessage(new ApiClientError(msg, 404, 'macrocycle-not-found'), 'Failed.')).toBe(msg);
  });

  it('falls back for anything else', () => {
    expect(writeFailureMessage(new ApiClientError('dup', 409), 'Failed.')).toBe('Failed.');
    expect(writeFailureMessage(new ApiClientError('moved', 409, 'macrocycle-moved'), 'Failed.')).toBe('Failed.');
    expect(writeFailureMessage(new Error('x'), 'Failed.')).toBe('Failed.');
  });
});
