import type { SupplementChange, SupplementStackResponse } from '@lifting-logbook/types';
import { describeChanges, dosesText, formatDay, isIsoDay, REMOVED_DAY_TYPE, restorableSeqs, shortDay, supplementsOnHref } from './supplementHistory';
import { dose, item } from './__tests__/supplementsTestStack';

const stack = (...items: ReturnType<typeof item>[]): SupplementStackResponse => ({ items, dayTypes: [], caffeineCutoff: '15:00' });

describe('dates', () => {
  it('formats a day without a time zone, and leaves anything else alone', () => {
    expect(formatDay('2026-11-18')).toBe('Nov 18, 2026');
    expect(formatDay('soon')).toBe('soon');
  });
  it('drops the year for a day in the current one', () => {
    expect(shortDay('2026-11-18', '2026-11-22')).toBe('Nov 18');
    expect(shortDay('2025-12-31', '2026-11-22')).toBe('Dec 31, 2025');
  });
  it('accepts only real calendar days, from the year 1000', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('1000-01-01')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('0002-11-18')).toBe(false);
    expect(isIsoDay('11/18/2026')).toBe(false);
    expect(isIsoDay(undefined)).toBe(false);
  });
  it('links a date to the History dialog on the Supplements page, and not a malformed one', () => {
    expect(supplementsOnHref('2026-06-01')).toBe('/supplements?history=2026-06-01');
    expect(supplementsOnHref('06/01/2026')).toBeUndefined();
  });
});

describe('dosesText', () => {
  const dayTypes = [{ id: 'lift', name: 'Push day' }];
  it('puts the amount first, says dose? for none, and joins doses with +', () => {
    const it2 = item('c', 'Creatine', { doses: [dose('pre', '', ['lift']), dose('all', '5 g')] });
    expect(dosesText(it2, dayTypes)).toBe('dose? · Pre-workout (Push day) + 5 g · Throughout the day');
    expect(dosesText(item('x', 'X'), dayTypes)).toBe('not scheduled');
  });
  it('says a removed day type, never the bare id', () => {
    const text = dosesText(item('x', 'X', { doses: [dose('pre', '1 scoop', ['gone'])] }), dayTypes);
    expect(text).toBe(`1 scoop · Pre-workout (${REMOVED_DAY_TYPE})`);
  });
});

const creatine = item('c', 'Creatine monohydrate');
const preX = item('p', 'Nutricost Pre-X');
const LOG: SupplementChange[] = [
  { seq: 1, date: '2026-11-01', type: 'added', item: creatine },
  { seq: 2, date: '2026-11-02', type: 'added', item: preX },
  { seq: 3, date: '2026-11-03', type: 'moved_to_pending', itemId: 'p' },
  { seq: 4, date: '2026-11-04', type: 'day_types_set', dayTypes: [] },
  { seq: 5, date: '2026-11-05', type: 'removed', item: creatine },
];

describe('describeChanges', () => {
  it('says what each change did: a verb, and what it acted on', () => {
    const w = describeChanges(LOG, []);
    expect(w.get(1)).toEqual({ verb: 'Added', object: 'Creatine monohydrate' });
    expect(w.get(3)).toEqual({ verb: 'Moved', object: 'Nutricost Pre-X to Pending' });
    expect(w.get(4)).toEqual({ verb: 'Changed', object: 'the day types' });
    expect(w.get(5)).toEqual({ verb: 'Removed', object: 'Creatine monohydrate' });
  });
  it('names an item from the current stack when the page of the log lacks its add, and otherwise "an item"', () => {
    const page: SupplementChange[] = [
      { seq: 7, date: '2026-11-07', type: 'started', itemId: 'p' },
      { seq: 8, date: '2026-11-08', type: 'started', itemId: 'zz' },
    ];
    const w = describeChanges(page, [preX]);
    expect(w.get(7)).toEqual({ verb: 'Started', object: 'Nutricost Pre-X' });
    expect(w.get(8)).toEqual({ verb: 'Started', object: 'an item' });
  });
  it('names an item gone from the stack by a later removal or mix in the page, not "an item"', () => {
    const mix = item('m', 'Pump mix', { parts: [{ itemId: 'cit', name: 'Citrulline', ingredients: [] }] });
    const page: SupplementChange[] = [
      { seq: 10, date: '2026-11-10', type: 'started', itemId: 'c' },
      { seq: 11, date: '2026-11-10', type: 'confirmed', itemId: 'cit' },
      { seq: 12, date: '2026-11-11', type: 'mix_created', mix, partIds: ['cit'] },
      { seq: 13, date: '2026-11-12', type: 'removed', item: creatine },
      { seq: 14, date: '2026-11-12', type: 'removed', item: mix },
    ];
    const w = describeChanges(page, []);
    expect(w.get(10)).toEqual({ verb: 'Started', object: 'Creatine monohydrate' });
    expect(w.get(11)).toEqual({ verb: 'Confirmed', object: 'Citrulline' });
    expect(w.get(12)).toEqual({ verb: 'Combined', object: 'Citrulline into Pump mix' });
  });
});

describe('restorableSeqs', () => {
  it('offers the latest removal of an item that is not in the stack', () => {
    expect([...restorableSeqs(LOG, stack(preX))]).toEqual([5]);
  });
  it('offers nothing for an item that is in the stack again', () => {
    expect([...restorableSeqs(LOG, stack(preX, creatine))]).toEqual([]);
  });
  it('offers only the latest of two removals of one item', () => {
    const twice: SupplementChange[] = [...LOG, { seq: 6, date: '2026-11-06', type: 'restored', itemId: 'c' }, { seq: 7, date: '2026-11-07', type: 'removed', item: creatine }];
    expect([...restorableSeqs(twice, stack())]).toEqual([7]);
  });
  // Each later change on its own makes the removal at seq 5 not restorable, with nothing in the stack.
  const mixWithC = item('m', 'Mix', { parts: [{ itemId: 'c', name: 'Creatine monohydrate', ingredients: [] }] });
  it.each<[string, SupplementChange]>([
    ['a restore of it', { seq: 6, date: '2026-11-06', type: 'restored', itemId: 'c' }],
    ['folding it into a mix', { seq: 6, date: '2026-11-06', type: 'folded_into_mix', mixId: 'm', itemId: 'c' }],
    ['a mix made with it', { seq: 6, date: '2026-11-06', type: 'mix_created', mix: mixWithC, partIds: ['c'] }],
    ['removing a mix that holds it', { seq: 6, date: '2026-11-06', type: 'removed', item: mixWithC }],
  ])('offers no restore after %s', (_name, later) => {
    const restorable = restorableSeqs([...LOG, later], stack());
    expect(restorable.has(5)).toBe(false);
  });
  it('keeps offering a removal a change to another item leaves alone', () => {
    const other: SupplementChange[] = [
      ...LOG,
      { seq: 6, date: '2026-11-06', type: 'restored', itemId: 'p' },
      { seq: 7, date: '2026-11-06', type: 'folded_into_mix', mixId: 'p', itemId: 'q' },
    ];
    expect(restorableSeqs(other, stack()).has(5)).toBe(true);
  });
  it('offers a removed mix, but not a part of it', () => {
    const mixRemoved: SupplementChange[] = [
      ...LOG,
      { seq: 6, date: '2026-11-06', type: 'restored', itemId: 'c' },
      { seq: 7, date: '2026-11-07', type: 'folded_into_mix', mixId: 'm', itemId: 'c' },
      { seq: 8, date: '2026-11-08', type: 'removed', item: mixWithC },
    ];
    expect([...restorableSeqs(mixRemoved, stack())]).toEqual([8]);
  });
});
