import {
  adaptogenAtNight,
  advisories,
  highCaffeine,
  highPotassium,
  ingredientTotals,
  findOverlaps,
  lateStimulant,
  missingAmount,
  placements,
  stackAsOf,
  supplementalProtein,
  validateStack,
  type AdvisoryContext,
} from '@src/core';
import type { SupplementChange, SupplementDayType, SupplementItem } from '@lifting-logbook/types';
import { LIFT, REST, dose, ing, item } from './fixtures';

const ctx = (stack: SupplementItem[], dayType: SupplementDayType = LIFT): AdvisoryContext => ({
  stack,
  dayType,
  placements: placements(stack, dayType.id),
  totals: ingredientTotals(stack, dayType.id),
});

describe('validateStack', () => {
  it('rejects a workout-slot dose with no day types', () => {
    const bad = item('a', { doses: [dose({ dayTypes: [] })] });
    expect(validateStack([bad], [LIFT, REST])).toHaveLength(1);
  });
  it('accepts a daily dose with no day types and a workout dose with one', () => {
    const ok = item('a', { doses: [dose(), dose({ slot: 'am', dayTypes: [] })] });
    expect(validateStack([ok], [LIFT, REST])).toEqual([]);
  });
  it('rejects an unknown day type', () => {
    expect(validateStack([item('a', { doses: [dose({ dayTypes: ['x'] })] })], [LIFT])).toHaveLength(1);
  });
});

describe('placements', () => {
  const creatine = item('creatine', {
    doses: [dose({ slot: 'pre' }), dose({ slot: 'all', dayTypes: [] })],
  });
  it('returns two on Lift day and one on Rest day', () => {
    expect(placements([creatine], 'lift')).toHaveLength(2);
    expect(placements([creatine], 'rest')).toHaveLength(1);
  });
  it('marks pending and unverified items as not counted', () => {
    const stack = [
      item('a'),
      item('b', { status: 'pending' }),
      item('c', { unverified: true }),
    ];
    expect(placements(stack, 'lift').map((p) => p.counted)).toEqual([true, false, false]);
  });
});

describe('ingredientTotals', () => {
  const preX = item('prex', { ingredients: [ing('caffeine', 300)] });
  const trans = item('trans', {
    ingredients: [ing('caffeine', 175)],
    doses: [dose({ slot: 'all', servings: 0.5, dayTypes: [] })],
  });
  it('sums caffeine per day type with shares', () => {
    const lift = ingredientTotals([preX, trans], "lift")[0]!;
    expect(lift?.total).toBe(387.5);
    expect(lift?.shares).toEqual([
      { itemId: 'prex', amount: 300 },
      { itemId: 'trans', amount: 87.5 },
    ]);
    expect(ingredientTotals([preX, trans], 'rest')[0]?.total).toBe(87.5);
  });
  it('doubles a two-scoop dose', () => {
    const t = ingredientTotals([item('a', { ingredients: [ing('x', 5)], doses: [dose({ servings: 2 })] })], 'lift');
    expect(t[0]?.total).toBe(10);
  });
  it('totals a mix from its parts', () => {
    const mix = item('mix', {
      parts: [
        { name: 'salt', ingredients: [ing('sodium', 500)] },
        { name: 'kcl', ingredients: [ing('potassium', 200)] },
      ],
    });
    expect(ingredientTotals([mix], 'lift').map((t) => [t.key, t.total])).toEqual([
      ['sodium', 500],
      ['potassium', 200],
    ]);
  });
  it('contributes zero for a dose with no amount and skips uncounted items', () => {
    const blank = item('a', { ingredients: [ing('x', 5)], doses: [dose({ amount: ' ' })] });
    expect(ingredientTotals([blank], 'lift')[0]?.total).toBe(0);
    expect(ingredientTotals([item('b', { ingredients: [ing('x', 5)], status: 'pending' })], 'lift')).toEqual([]);
  });
  it('converts units into the first one seen', () => {
    const stack = [
      item('a', { ingredients: [ing('x', 1, 'g')] }),
      item('b', { ingredients: [ing('x', 500)] }),
    ];
    expect(ingredientTotals(stack, 'lift')[0]).toMatchObject({ unit: 'g', total: 1.5 });
  });
});

describe('supplementalProtein', () => {
  const quest = item('quest', { ingredients: [ing('protein', 24, 'g')] });
  const citrulline = item('cit', { ingredients: [ing('citrulline', 6, 'g')] });
  it('counts only protein', () => {
    expect(supplementalProtein([quest, citrulline], 'lift')).toBe(24);
    expect(supplementalProtein([quest, citrulline], 'rest')).toBe(0);
  });
});

describe('advisories', () => {
  const caffeinated = (mg: number, p = {}) => item('c', { ingredients: [ing('caffeine', mg)], ...p });
  it('lateStimulant fires for a late session and not an early one', () => {
    const late = { ...LIFT, sessionTime: '18:00' };
    expect(lateStimulant.evaluate(ctx([caffeinated(100)], late))?.itemIds).toEqual(['c']);
    expect(lateStimulant.evaluate(ctx([caffeinated(100)]))).toBeNull();
  });
  it('highCaffeine fires at 350 mg and not below', () => {
    expect(highCaffeine.evaluate(ctx([caffeinated(350)]))?.itemIds).toEqual(['c']);
    expect(highCaffeine.evaluate(ctx([caffeinated(349)]))).toBeNull();
  });
  it('highPotassium fires above 3,400 mg and not at it', () => {
    const k = (mg: number) => item('k', { ingredients: [ing('potassium', mg)] });
    const a = highPotassium.evaluate(ctx([k(3401)]));
    expect(a?.itemIds).toEqual(['k']);
    expect(a?.message).toMatch(/spreading it through the day is fine/);
    expect(highPotassium.evaluate(ctx([k(3400)]))).toBeNull();
  });
  it('adaptogenAtNight fires in pm and not in am', () => {
    const ash = (slot: 'pm' | 'am') =>
      item('ash', { ingredients: [ing('ashwagandha', 300)], doses: [dose({ slot, dayTypes: [] })] });
    expect(adaptogenAtNight.evaluate(ctx([ash('pm')]))?.itemIds).toEqual(['ash']);
    expect(adaptogenAtNight.evaluate(ctx([ash('am')]))).toBeNull();
  });
  it('missingAmount fires for a blank amount and not a filled one', () => {
    expect(missingAmount.evaluate(ctx([item('a', { doses: [dose({ amount: '' })] })]))?.itemIds).toEqual(['a']);
    expect(missingAmount.evaluate(ctx([item('a')]))).toBeNull();
  });
  it('advisories() runs every rule', () => {
    const r = advisories([caffeinated(400)], LIFT);
    expect(r.map((a) => a.rule)).toEqual(['highCaffeine']);
    expect(r[0]?.source).toBe('fda-caffeine');
  });
});

describe('stackAsOf', () => {
  const a = item('a');
  const log: SupplementChange[] = [
    { date: '2026-01-01', type: 'added', item: a },
    { date: '2026-01-03', type: 'removed', itemId: 'a' },
    { date: '2026-01-05', type: 'restored', itemId: 'a' },
  ];
  it('is absent while removed and present once restored', () => {
    expect(stackAsOf(log, '2026-01-02')).toHaveLength(1);
    expect(stackAsOf(log, '2026-01-04')).toHaveLength(0);
    expect(stackAsOf(log, '2026-01-05')).toHaveLength(1);
  });
  it('applies edits, moves, pending, started and confirmed', () => {
    const l: SupplementChange[] = [
      { date: '2026-01-01', type: 'added', item: item('a', { unverified: true }) },
      { date: '2026-01-02', type: 'edited', itemId: 'a', changes: { name: 'New' } },
      { date: '2026-01-02', type: 'moved', itemId: 'a', doses: [dose({ slot: 'post' })] },
      { date: '2026-01-02', type: 'moved_to_pending', itemId: 'a' },
      { date: '2026-01-03', type: 'started', itemId: 'a' },
      { date: '2026-01-03', type: 'confirmed', itemId: 'a' },
    ];
    expect(stackAsOf(l, '2026-01-02')[0]).toMatchObject({ name: 'New', status: 'pending', unverified: true });
    expect(stackAsOf(l, '2026-01-03')[0]).toMatchObject({ status: 'active', unverified: false });
    expect(stackAsOf(l, "2026-01-03")[0]?.doses[0]?.slot).toBe('post');
  });
  it('hides parts folded into a mix', () => {
    const l: SupplementChange[] = [
      { date: '2026-01-01', type: 'added', item: item('na', { ingredients: [ing('sodium', 5)] }) },
      { date: '2026-01-01', type: 'added', item: item('k', { ingredients: [ing('potassium', 7)] }) },
      { date: '2026-01-01', type: 'added', item: item('cl', { ingredients: [ing('chloride', 9)] }) },
      { date: '2026-01-02', type: 'mix_created', mix: item('mix'), partIds: ['na', 'k'] },
      { date: '2026-01-03', type: 'folded_into_mix', mixId: 'mix', itemId: 'cl' },
      { date: '2026-01-04', type: 'restored', itemId: 'na' },
    ];
    expect(stackAsOf(l, '2026-01-01').map((i) => i.id)).toEqual(['na', 'k', 'cl']);
    expect(stackAsOf(l, '2026-01-02').map((i) => i.id)).toEqual(['cl', 'mix']);
    const end = stackAsOf(l, '2026-01-04');
    expect(end.map((i) => i.id)).toEqual(['mix']);
    expect(end[0]?.parts?.map((p) => p.name)).toEqual(['na', 'k', 'cl']);
  });
  it('orders by date regardless of log order', () => {
    expect(stackAsOf([...log].reverse(), '2026-01-04')).toHaveLength(0);
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
  it('requires a shared day type for workout slots and skips pending or unrelated items', () => {
    const restPre = item('r', { ingredients: [ing('taurine', 1, 'g')], doses: [dose({ dayTypes: ['rest'] })] });
    const pending = item('p', { ingredients: [ing('taurine', 1, 'g')], status: 'pending' });
    const other = item('o', { ingredients: [ing('zinc', 1)] });
    const o = findOverlaps(candidate, [restPre, pending, other]);
    expect(o).toHaveLength(1);
    expect(o[0]?.sameSlot).toBe(false);
  });
});
