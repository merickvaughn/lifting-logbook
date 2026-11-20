import { applyChange, emptyStackState, isSameData, stackAsOf } from '@src/core';
import { LIFT, REST, changeLog, dose, item } from './supplementFixtures';

describe('applyChange', () => {
  it('puts a mix in its first part’s place and a restored item at the end', () => {
    const state = emptyStackState();
    for (const id of ['a', 'b', 'c']) applyChange(state, { type: 'added', item: item(id) });
    applyChange(state, { type: 'mix_created', mix: item('mix'), partIds: ['b', 'a'] });
    expect(state.items.map((i) => i.id)).toEqual(['mix', 'c']);
    expect(state.folded.map((f) => [f.item.id, f.mixId])).toEqual([
      ['b', 'mix'],
      ['a', 'mix'],
    ]);

    applyChange(state, { type: 'removed', item: item('c') });
    applyChange(state, { type: 'mix_split', mixId: 'mix' });
    expect(state.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(applyChange(state, { type: 'restored', itemId: 'c' })).toEqual([]);
    expect(state.items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(state.removed).toEqual([]);
  });

  it('restores the item as its removal recorded it', () => {
    const state = emptyStackState();
    applyChange(state, { type: 'added', item: item('a') });
    const asRemoved = item('a', { name: 'As removed' });
    applyChange(state, { type: 'removed', item: asRemoved });
    applyChange(state, { type: 'restored', itemId: 'a' });
    expect(state.items).toEqual([asRemoved]);
  });

  it('reports why it could not restore, and changes nothing', () => {
    const state = emptyStackState();
    applyChange(state, { type: 'added', item: item('a') });
    applyChange(state, { type: 'added', item: item('b') });
    applyChange(state, { type: 'mix_created', mix: item('mix'), partIds: ['b'] });
    const before = structuredClone(state);
    expect(applyChange(state, { type: 'restored', itemId: 'a' })).toEqual([{ itemId: 'a', reason: 'not-removed' }]);
    expect(applyChange(state, { type: 'restored', itemId: 'b' })).toEqual([{ itemId: 'b', reason: 'folded-item' }]);
    expect(applyChange(state, { type: 'restored', itemId: 'x' })).toEqual([{ itemId: 'x', reason: 'unknown-item' }]);
    expect(state).toEqual(before);
  });

  it('reports a change to a removed item without applying it', () => {
    const state = emptyStackState();
    applyChange(state, { type: 'added', item: item('a') });
    applyChange(state, { type: 'removed', item: item('a') });
    expect(applyChange(state, { type: 'started', itemId: 'a' })).toEqual([{ itemId: 'a', reason: 'removed-item' }]);
    expect(state.items).toEqual([]);
  });

  it('moves the doses of an item folded into a mix, so a split brings back the cleaned doses', () => {
    const state = emptyStackState();
    applyChange(state, { type: 'added', item: item('a', { doses: [dose({ dayTypes: ['lift', 'rest'] })] }) });
    applyChange(state, { type: 'added', item: item('b') });
    applyChange(state, { type: 'mix_created', mix: item('mix'), partIds: ['a', 'b'] });
    expect(applyChange(state, { type: 'moved', itemId: 'a', doses: [dose({ dayTypes: ['lift'] })] })).toEqual([]);
    applyChange(state, { type: 'mix_split', mixId: 'mix' });
    expect(state.items[0]?.doses).toEqual([dose({ dayTypes: ['lift'] })]);
  });

  it('sets the day types and the caffeine cutoff', () => {
    const state = emptyStackState();
    applyChange(state, { type: 'day_types_set', dayTypes: [LIFT, REST] });
    applyChange(state, { type: 'caffeine_cutoff_set', caffeineCutoff: '13:00' });
    expect(state).toMatchObject({ dayTypes: [LIFT, REST], caffeineCutoff: '13:00' });
  });

  it('isSameData compares data, not key order, prototypes or undefined properties', () => {
    class Dose {
      slot = 'am';
      dayTypes = ['lift'];
    }
    expect(isSameData(new Dose(), { dayTypes: ['lift'], slot: 'am', note: undefined })).toBe(true);
    expect(isSameData({ dayTypes: ['lift'] }, { dayTypes: ['rest'] })).toBe(false);
    expect(isSameData(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('is what stackAsOf replays with', () => {
    const log = changeLog(
      { date: '2026-01-01', type: 'added', item: item('a') },
      { date: '2026-01-01', type: 'added', item: item('b') },
      { date: '2026-01-02', type: 'mix_created', mix: item('mix'), partIds: ['b', 'a'] },
    );
    const state = emptyStackState();
    for (const change of log) applyChange(state, change);
    expect(stackAsOf(log, '2026-01-02').stack).toEqual(state.items);
  });
});
