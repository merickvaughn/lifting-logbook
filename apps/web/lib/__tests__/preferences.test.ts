jest.mock('@/lib/active-program', () => ({
  getUserSettings: jest.fn(),
}));

import { getUserSettings } from '@/lib/active-program';
import { getPreferredUnit } from '@/lib/preferences';

const mockedSettings = getUserSettings as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getPreferredUnit', () => {
  it('returns the unit the user set', async () => {
    mockedSettings.mockResolvedValue({ unit: 'kg' });
    await expect(getPreferredUnit()).resolves.toBe('kg');
  });

  it('falls back to lbs when no unit is set', async () => {
    mockedSettings.mockResolvedValue({ unit: null });
    await expect(getPreferredUnit()).resolves.toBe('lbs');
  });

  it('falls back to lbs, without throwing, when the settings fetch fails', async () => {
    // The paired test the `.catch(() => null)` needs: a display preference must
    // never take a page down, and the data-level assertion (lbs, not undefined
    // or a rejection) is what a page that stopped reading settings would fail.
    mockedSettings.mockRejectedValue(new Error('API down'));
    await expect(getPreferredUnit()).resolves.toBe('lbs');
  });
});
