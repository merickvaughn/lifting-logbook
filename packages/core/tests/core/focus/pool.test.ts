import { FOCUS_AREAS, FOCUS_AREA_MUSCLES } from '@lifting-logbook/types';
import { DEFAULT_FOCUS_POOL_SIZE, LIFT_CATALOG, defaultFocusPool, defaultPoolEntry } from '@src/core';

describe('defaultFocusPool', () => {
  it.each(FOCUS_AREAS)('gives %s a non-empty pool of catalog accessories that train it', (area) => {
    const pool = defaultFocusPool(area);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.length).toBeLessThanOrEqual(DEFAULT_FOCUS_POOL_SIZE);
    const groups: readonly string[] = FOCUS_AREA_MUSCLES[area];
    for (const entry of pool) {
      const lift = LIFT_CATALOG.find((candidate) => candidate.name === entry.lift);
      expect(lift?.classification).toBe('accessory');
      expect(lift?.muscles.primary.some((muscle) => groups.includes(muscle))).toBe(true);
    }
  });

  it('takes lifts in catalog order with the starting prescription', () => {
    const expected = LIFT_CATALOG.filter(
      (lift) => lift.classification === 'accessory' && lift.muscles.primary.includes('Biceps'),
    )
      .slice(0, DEFAULT_FOCUS_POOL_SIZE)
      .map((lift) => defaultPoolEntry(lift.name));
    expect(defaultFocusPool('Biceps')).toEqual(expected);
  });

  it('never picks a compound, even when one trains the area', () => {
    const lifts = defaultFocusPool('Chest').map((entry) => entry.lift);
    expect(lifts).not.toContain('Bench Press');
  });
});
