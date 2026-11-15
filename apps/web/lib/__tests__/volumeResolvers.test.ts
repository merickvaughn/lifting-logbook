jest.mock('@/lib/api', () => ({
  fetchAllLiftMetadata: jest.fn(),
  fetchCustomLifts: jest.fn(),
}));

import { buildMuscleTargetResolver, movementPatternsFor } from '@lifting-logbook/core';
import { fetchAllLiftMetadata, fetchCustomLifts } from '@/lib/api';
import { VOLUME_INPUTS_TIMEOUT_MS, loadVolumeResolvers } from '@/lib/volumeResolvers';

const mockedMetadata = fetchAllLiftMetadata as unknown as jest.Mock;
const mockedCustomLifts = fetchCustomLifts as unknown as jest.Mock;

const override = {
  lift: 'Bench Press',
  muscleGroups: ['Chest'],
  secondaryMuscleGroups: ['Rear Delts'],
  substitutions: [],
  foundational: false,
  progression: null,
  progressionIncrement: null,
  repsLow: null,
  repsHigh: null,
};
const customLift = {
  id: 'c0ffee00-0000-4000-8000-000000000001',
  name: 'Sled Push',
  classification: 'accessory',
  movementProfile: { patterns: ['carry'], jointActions: [], complexity: 'compound' },
  isBodyweightComponent: false,
};

describe('loadVolumeResolvers (#1017)', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedMetadata.mockResolvedValue([override]);
    mockedCustomLifts.mockResolvedValue([customLift]);
  });
  afterEach(() => error.mockRestore());

  it('returns the overrides and custom lifts the resolvers are built from', async () => {
    const inputs = await loadVolumeResolvers('test-page');

    expect(inputs).toEqual({
      overrides: [override],
      customLifts: [customLift],
      overridesFailed: false,
      customLiftsFailed: false,
    });
    // Serializable, as a server component must pass it to a client one.
    expect(JSON.parse(JSON.stringify(inputs))).toEqual(inputs);
    expect(buildMuscleTargetResolver(inputs.overrides)('Bench Press')).toEqual({
      primary: ['Chest'],
      secondary: ['Rear Delts'],
      source: 'custom',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('counts by built-in defaults when the metadata fetch fails, and logs it', async () => {
    mockedMetadata.mockRejectedValue(new Error('API 500'));

    const inputs = await loadVolumeResolvers('test-page');

    // The override is gone, so Bench Press reads its defaults, and the custom lifts still load.
    expect(inputs.overrides).toEqual([]);
    expect(inputs.overridesFailed).toBe(true);
    expect(inputs.customLifts).toEqual([customLift]);
    expect(inputs.customLiftsFailed).toBe(false);
    expect(buildMuscleTargetResolver(inputs.overrides)('Bench Press')).toEqual({
      primary: ['Chest'],
      secondary: ['Triceps', 'Front Delts'],
      source: 'default',
    });
    expect(error).toHaveBeenCalledWith(
      '[test-page] lift metadata fetch failed; counting sets by built-in muscle defaults',
      expect.any(Error),
    );
  });

  it('leaves custom lifts uncounted when their fetch fails, and logs it', async () => {
    mockedCustomLifts.mockRejectedValue(new Error('API 503'));

    const inputs = await loadVolumeResolvers('test-page');

    expect(inputs.customLifts).toEqual([]);
    expect(inputs.customLiftsFailed).toBe(true);
    expect(inputs.overrides).toEqual([override]);
    expect(inputs.overridesFailed).toBe(false);
    expect(movementPatternsFor('Sled Push', inputs.customLifts)).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[test-page] custom lifts fetch failed; leaving custom lifts uncounted',
      expect.any(Error),
    );
  });

  describe('a slow fetch', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      jest.useFakeTimers();
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.useRealTimers();
      warn.mockRestore();
    });

    it('stops waiting for the overrides after the budget, and logs it', async () => {
      mockedMetadata.mockReturnValue(new Promise(() => {}));

      const pending = loadVolumeResolvers('test-page');
      await jest.advanceTimersByTimeAsync(VOLUME_INPUTS_TIMEOUT_MS);
      const inputs = await pending;

      expect(inputs).toEqual({
        overrides: [],
        customLifts: [customLift],
        overridesFailed: true,
        customLiftsFailed: false,
      });
      expect(warn).toHaveBeenCalledWith(
        '[test-page] lift metadata fetch slow; counting sets by built-in muscle defaults',
      );
      expect(error).not.toHaveBeenCalled();
    });

    it('stops waiting for the custom lifts after the budget, and logs it', async () => {
      mockedCustomLifts.mockReturnValue(new Promise(() => {}));

      const pending = loadVolumeResolvers('test-page');
      await jest.advanceTimersByTimeAsync(VOLUME_INPUTS_TIMEOUT_MS);
      const inputs = await pending;

      expect(inputs).toEqual({
        overrides: [override],
        customLifts: [],
        overridesFailed: false,
        customLiftsFailed: true,
      });
      expect(warn).toHaveBeenCalledWith('[test-page] custom lifts fetch slow; leaving custom lifts uncounted');
    });

    it('waits for a fetch that answers within the budget', async () => {
      mockedMetadata.mockReturnValue(
        new Promise((resolve) => setTimeout(() => resolve([override]), VOLUME_INPUTS_TIMEOUT_MS - 1)),
      );

      const pending = loadVolumeResolvers('test-page');
      await jest.advanceTimersByTimeAsync(VOLUME_INPUTS_TIMEOUT_MS);
      const inputs = await pending;

      expect(inputs.overrides).toEqual([override]);
      expect(inputs.overridesFailed).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
