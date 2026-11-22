import type { SupplementChange, SupplementStackResponse } from '@lifting-logbook/types';
import { describeChanges, doseText, formatDay, groupStack, isIsoDay, REMOVED_DAY_TYPE, restorableSeqs, supplementsOnHref } from './supplementHistory';
import { dose, item } from './__tests__/supplementsTestStack';

const stack = (...items: ReturnType<typeof item>[]): SupplementStackResponse => ({ items, dayTypes: [], caffeineCutoff: '15:00' });

describe('dates', () => {
  it('formats a day without a time zone, and leaves anything else alone', () => {
    expect(formatDay('2026-11-18')).toBe('Nov 18, 2026');
    expect(formatDay('soon')).toBe('soon');
  });
  it('accepts only real calendar days', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('11/18/2026')).toBe(false);
    expect(isIsoDay(undefined)).toBe(false);
  });
  it('links a date to the history view, and not a malformed one', () => {
    expect(supplementsOnHref('2026-06-01')).toBe('/supplements/history?date=2026-06-01');
    expect(supplementsOnHref('06/01/2026')).toBeUndefined();
  });
});

describe('doseText', () => {
  const dayTypes = [{ id: 'lift', name: 'Push day' }];
  it('names the day types as they were on that date', () => {
    expect(doseText(dose('pre', '1 scoop', ['lift']), dayTypes)).toBe('Pre-workout (Push day) · 1 scoop');
    expect(doseText(dose('am', '', []), dayTypes)).toBe('Morning');
  });
  it('says a removed day type, never the bare id', () => {
    const text = doseText(dose('pre', '1 scoop', ['gone']), dayTypes);
    expect(text).toContain(REMOVED_DAY_TYPE);
    expect(text).not.toContain('gone');
  });
});

describe('groupStack', () => {
  it('groups by workout, daily, unscheduled and pending, once each', () => {
    const groups = groupStack([
      item('a', 'A', { doses: [dose('am', '1'), dose('pre', '1', ['lift'])] }),
      item('b', 'B', { doses: [dose('pm', '1')] }),
      item('c', 'C'),
      item('d', 'D', { status: 'pending', doses: [dose('am', '1')] }),
    ]);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['workout', ['a']],
      ['daily', ['b']],
      ['unscheduled', ['c']],
      ['pending', ['d']],
    ]);
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
  it('says what each change did, in words', () => {
    const w = describeChanges(LOG, []);
    expect(w.get(1)).toBe('Added Creatine monohydrate');
    expect(w.get(3)).toBe('Moved Nutricost Pre-X to Pending');
    expect(w.get(4)).toBe('Day types changed');
    expect(w.get(5)).toBe('Removed Creatine monohydrate');
  });
  it('names an item from the current stack when the page of the log lacks its add, and otherwise "an item"', () => {
    const page: SupplementChange[] = [
      { seq: 7, date: '2026-11-07', type: 'started', itemId: 'p' },
      { seq: 8, date: '2026-11-08', type: 'started', itemId: 'zz' },
    ];
    const w = describeChanges(page, [preX]);
    expect(w.get(7)).toBe('Started Nutricost Pre-X');
    expect(w.get(8)).toBe('Started an item');
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
  it('offers nothing for an item folded into a mix, or a part of a removed mix', () => {
    const mix = item('m', 'Mix', { parts: [{ itemId: 'c', name: 'Creatine monohydrate', ingredients: [] }] });
    const folded: SupplementChange[] = [
      ...LOG,
      { seq: 6, date: '2026-11-06', type: 'restored', itemId: 'c' },
      { seq: 7, date: '2026-11-07', type: 'folded_into_mix', mixId: 'm', itemId: 'c' },
    ];
    expect([...restorableSeqs(folded, stack(mix))]).toEqual([]);
    const mixRemoved: SupplementChange[] = [...folded, { seq: 8, date: '2026-11-08', type: 'removed', item: mix }];
    expect([...restorableSeqs(mixRemoved, stack())]).toEqual([8]);
  });
});
