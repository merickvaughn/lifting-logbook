import type {
  Ingredient,
  SupplementAdvisory,
  SupplementChange,
  SupplementDose,
  SupplementItem,
  SupplementPart,
} from '@lifting-logbook/types';
import { item } from './supplementFixtures';

// Compile-time checks of the shared supplement types, run by `npm run typecheck`. Each
// `@ts-expect-error` asserts that the line under it does NOT compile; if a type is widened
// so that it does, the directive is unused and the typecheck fails. Jest only runs the
// values, which is why each case is also a plain assertion.

describe('supplement types', () => {
  it('limits units, statuses and slots to their lists', () => {
    // @ts-expect-error asserts that `kg` is not an IngredientUnit
    const kg: Ingredient = { key: 'caffeine', amount: 1, unit: 'kg' };
    // @ts-expect-error asserts that `retired` is not a SupplementStatus
    const retired: SupplementItem = item('a', { status: 'retired' });
    // @ts-expect-error asserts that `night` is not a SupplementSlot (the Night slot is `pm`)
    const night: SupplementDose = { slot: 'night', amount: '', servings: 1, dayTypes: [] };
    expect([kg.unit, retired.status, night.slot]).toEqual(['kg', 'retired', 'night']);
  });

  it('requires a part to name the item it came from', () => {
    // @ts-expect-error asserts that a SupplementPart needs `itemId`
    const part: SupplementPart = { name: 'salt', ingredients: [] };
    expect(part.name).toBe('salt');
  });

  it('requires a seq on every change and a snapshot on a removal', () => {
    // @ts-expect-error asserts that a change needs `seq`
    const unsequenced: SupplementChange = { date: '2026-01-01', type: 'started', itemId: 'a' };
    // @ts-expect-error asserts that `removed` carries the item, not just its id
    const bare: SupplementChange = { date: '2026-01-01', seq: 0, type: 'removed', itemId: 'a' };
    const split: SupplementChange = { date: '2026-01-01', seq: 1, type: 'mix_split', mixId: 'm' };
    expect([unsequenced.type, bare.type, split.type]).toEqual(['started', 'removed', 'mix_split']);
  });

  it('lets an edit change only descriptive fields', () => {
    const rename: SupplementChange = { date: '2026-01-01', seq: 0, type: 'edited', itemId: 'a', changes: { name: 'B' } };
    // @ts-expect-error asserts that an edit can't set `status`; `started` and `moved_to_pending` do
    const status: SupplementChange = { date: '2026-01-01', seq: 1, type: 'edited', itemId: 'a', changes: { status: 'pending' } };
    // @ts-expect-error asserts that an edit can't set `doses`; `moved` does
    const doses: SupplementChange = { date: '2026-01-01', seq: 2, type: 'edited', itemId: 'a', changes: { doses: [] } };
    expect([rename.seq, status.seq, doses.seq]).toEqual([0, 1, 2]);
  });

  it('limits an advisory to known rules and sources', () => {
    // @ts-expect-error asserts that `lateCaffeine` is not a SupplementAdvisoryRule
    const rule: SupplementAdvisory = { rule: 'lateCaffeine', itemIds: [], message: '', source: 'fda-caffeine' };
    // @ts-expect-error asserts that `blog` is not a SupplementAdvisorySource
    const source: SupplementAdvisory = { rule: 'highCaffeine', itemIds: [], message: '', source: 'blog' };
    expect([rule.rule, source.source]).toEqual(['lateCaffeine', 'blog']);
  });
});
