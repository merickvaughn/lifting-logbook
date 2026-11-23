import { dosesShareSlot, findOverlaps } from '@src/core';
import { dose, ing, item } from './supplementFixtures';

describe('dosesShareSlot', () => {
  it('needs the same slot', () => {
    expect(dosesShareSlot(dose({ slot: 'am', dayTypes: [] }), dose({ slot: 'am', dayTypes: [] }))).toBe(true);
    expect(dosesShareSlot(dose({ slot: 'am', dayTypes: [] }), dose({ slot: 'pm', dayTypes: [] }))).toBe(false);
  });
  it('needs a shared day type in a workout slot, but not in a time-of-day one', () => {
    expect(dosesShareSlot(dose({ dayTypes: ['lift'] }), dose({ dayTypes: ['lift', 'rest'] }))).toBe(true);
    expect(dosesShareSlot(dose({ dayTypes: ['lift'] }), dose({ dayTypes: ['rest'] }))).toBe(false);
    expect(dosesShareSlot(dose({ slot: 'am', dayTypes: ['lift'] }), dose({ slot: 'am', dayTypes: ['rest'] }))).toBe(true);
  });
});

describe('findOverlaps', () => {
  const taurinePre = item('taurinePre', { ingredients: [ing('taurine', 1, 'g')] });
  const citrullineAm = item('citAm', {
    ingredients: [ing('citrulline', 6, 'g'), ing('taurine', 500)],
    doses: [dose({ slot: 'am', dayTypes: [] })],
  });
  const candidate = item('new', { ingredients: [ing('taurine', 2, 'g')] });
  it('pre-selects the same-slot taurine item but not the morning one', () => {
    const o = findOverlaps(candidate, [taurinePre, citrullineAm]);
    expect(o.find((x) => x.item.id === 'taurinePre')).toMatchObject({ sameSlot: true, preselect: true });
    expect(o.find((x) => x.item.id === 'citAm')).toMatchObject({ sameSlot: false, preselect: false });
  });
  it('does not pre-select when the candidate supplies less', () => {
    const big = item('big', { ingredients: [ing('taurine', 3, 'g')] });
    expect(findOverlaps(candidate, [big])[0]).toMatchObject({ sameSlot: true, preselect: false });
  });
  it('compares amounts across units', () => {
    const mg = (amount: number) => item('mg', { ingredients: [ing('taurine', amount)] });
    expect(findOverlaps(candidate, [mg(1500)])[0]).toMatchObject({ sameSlot: true, preselect: true });
    expect(findOverlaps(candidate, [mg(2500)])[0]).toMatchObject({ sameSlot: true, preselect: false });
  });
  it('treats 1.005 g as exactly 1005 mg', () => {
    const grams = item('g', { ingredients: [ing('taurine', 1.005, 'g')] });
    expect(findOverlaps(grams, [item('mg', { ingredients: [ing('taurine', 1005)] })])[0]?.preselect).toBe(true);
  });
  it('requires a shared day type for workout slots and skips pending or unrelated items', () => {
    const restPre = item('r', { ingredients: [ing('taurine', 1, 'g')], doses: [dose({ dayTypes: ['rest'] })] });
    const pending = item('p', { ingredients: [ing('taurine', 1, 'g')], status: 'pending' });
    const other = item('o', { ingredients: [ing('zinc', 1)] });
    const o = findOverlaps(candidate, [restPre, pending, other]);
    expect(o).toHaveLength(1);
    expect(o[0]?.sameSlot).toBe(false);
  });
});
