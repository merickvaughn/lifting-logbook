import { SupplementChange, SupplementItem } from '@lifting-logbook/types';
import { MalformedSupplementDataError, parseChange, parseItem, toJson } from './supplement-payload';

const item: SupplementItem = {
  id: 'mix',
  name: 'Pump mix',
  keyCompound: 'citrulline',
  timing: 'pre',
  shortNote: 's',
  longNote: 'l',
  status: 'pending',
  unverified: true,
  links: ['https://example.com/a'],
  ingredients: [{ key: 'citrulline', amount: 6, unit: 'g' }],
  parts: [{ itemId: 'a', name: 'A', ingredients: [{ key: 'caffeine', amount: 100, unit: 'mg' }] }],
  doses: [{ slot: 'pre', amount: '1 scoop', servings: 1.5, dayTypes: ['lift'] }],
};

/** Stores `change` as save() does and reads it back. */
function roundTrip(change: SupplementChange): SupplementChange {
  const { date, seq, type, ...payload } = change;
  // Through JSON text, as Postgres hands it back.
  return parseChange({ date, seq, type, payload: JSON.parse(JSON.stringify(toJson(payload))) });
}

describe('supplement change payloads', () => {
  const base = { date: '2026-11-20', seq: 7 };
  const every: SupplementChange[] = [
    { ...base, type: 'added', item },
    { ...base, type: 'edited', itemId: 'a', changes: { name: 'B', links: [], ingredients: [] } },
    { ...base, type: 'moved', itemId: 'a', doses: item.doses },
    { ...base, type: 'started', itemId: 'a' },
    { ...base, type: 'moved_to_pending', itemId: 'a' },
    { ...base, type: 'removed', item },
    { ...base, type: 'restored', itemId: 'a' },
    { ...base, type: 'confirmed', itemId: 'a' },
    { ...base, type: 'mix_created', mix: item, partIds: ['a', 'b'] },
    { ...base, type: 'folded_into_mix', mixId: 'mix', itemId: 'a' },
    { ...base, type: 'mix_split', mixId: 'mix' },
    { ...base, type: 'day_types_set', dayTypes: [{ id: 'lift', name: 'Lift', sessionTime: '17:00' }, { id: 'rest', name: 'Rest' }] },
    { ...base, type: 'caffeine_cutoff_set', caffeineCutoff: '13:00' },
  ];

  it.each(every)('reads back a stored $type change unchanged', (change) => {
    expect(roundTrip(change)).toEqual(change);
  });

  it('fills the fields an older entry lacks with their defaults, so a restore gets a whole item', () => {
    const restored = parseChange({ ...base, type: 'removed', payload: { item: { id: 'old', name: 'Old', doses: [{ slot: 'am', servings: 1 }] } } });
    expect(restored).toEqual({
      ...base,
      type: 'removed',
      item: {
        id: 'old',
        name: 'Old',
        keyCompound: '',
        timing: '',
        shortNote: '',
        longNote: '',
        status: 'active',
        unverified: false,
        links: [],
        ingredients: [],
        doses: [{ slot: 'am', amount: '', servings: 1, dayTypes: [] }],
      },
    });
  });

  it('throws on a field of the wrong type, an unknown value, or an unknown change type', () => {
    expect(() => parseItem({ id: 'x', name: 3 })).toThrow(MalformedSupplementDataError);
    expect(() => parseItem({ id: 'x', status: 'paused' })).toThrow(/status "paused"/);
    expect(() => parseItem({ id: 'x', doses: [{ slot: 'night', servings: 1 }] })).toThrow(/slot "night"/);
    expect(() => parseItem({ name: 'no id' })).toThrow(/id is not a string/);
    expect(() => parseChange({ ...base, type: 'imported', payload: {} })).toThrow(/unknown type "imported"/);
    expect(() => parseChange({ ...base, type: 'moved', payload: [] })).toThrow(/payload is not an object/);
  });

  it('stores only JSON, leaving out undefined properties', () => {
    expect(toJson({ a: 1, b: undefined, c: [true, 'x'] })).toEqual({ a: 1, c: [true, 'x'] });
    expect(() => toJson({ a: null })).toThrow(MalformedSupplementDataError);
    expect(() => toJson(Number.NaN)).toThrow(MalformedSupplementDataError);
    expect(() => toJson(() => 1)).toThrow(MalformedSupplementDataError);
  });
});
