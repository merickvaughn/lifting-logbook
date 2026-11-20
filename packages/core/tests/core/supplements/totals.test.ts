import { ingredientTotals, supplementalProtein, totalOf } from '@src/core';
import { dose, ing, item } from './supplementFixtures';

describe('ingredientTotals', () => {
  const preX = item('prex', { ingredients: [ing('caffeine', 300)] });
  const trans = item('trans', {
    ingredients: [ing('caffeine', 175)],
    doses: [dose({ slot: 'all', servings: 0.5, dayTypes: [] })],
  });
  it('sums caffeine per day type with shares', () => {
    const lift = ingredientTotals([preX, trans], 'lift');
    expect(totalOf(lift, 'caffeine', 'mg')).toBe(387.5);
    expect(lift[0]?.shares).toEqual([
      { itemId: 'prex', ng: 300_000_000 },
      { itemId: 'trans', ng: 87_500_000 },
    ]);
    expect(totalOf(ingredientTotals([preX, trans], 'rest'), 'caffeine', 'mg')).toBe(87.5);
  });
  it('doubles a two-scoop dose', () => {
    const t = ingredientTotals([item('a', { ingredients: [ing('x', 5)], doses: [dose({ servings: 2 })] })], 'lift');
    expect(totalOf(t, 'x', 'mg')).toBe(10);
  });
  it('totals a mix from its parts', () => {
    const mix = item('mix', {
      parts: [
        { itemId: 'salt', name: 'salt', ingredients: [ing('sodium', 500)] },
        { itemId: 'kcl', name: 'kcl', ingredients: [ing('potassium', 200)] },
      ],
    });
    const t = ingredientTotals([mix], 'lift');
    expect(t.map((x) => [x.key, totalOf(t, x.key, 'mg')])).toEqual([
      ['sodium', 500],
      ['potassium', 200],
    ]);
  });
  it('contributes zero for a dose with no amount and skips uncounted items', () => {
    const blank = item('a', { ingredients: [ing('x', 5)], doses: [dose({ amount: ' ' })] });
    expect(totalOf(ingredientTotals([blank], 'lift'), 'x', 'mg')).toBe(0);
    expect(ingredientTotals([item('b', { ingredients: [ing('x', 5)], status: 'pending' })], 'lift')).toEqual([]);
  });
  it('totals mcg, mg and g exactly', () => {
    const stack = [
      item('d3', { ingredients: [ing('vitaminD', 50, 'mcg')] }),
      item('multi', { ingredients: [ing('vitaminD', 0.025)] }),
      item('a', { ingredients: [ing('x', 1, 'g')] }),
      item('b', { ingredients: [ing('x', 500)] }),
      item('c', { ingredients: [ing('x', 250, 'mcg')] }),
    ];
    const t = ingredientTotals(stack, 'lift');
    expect(totalOf(t, 'vitaminD', 'mcg')).toBe(75);
    expect(totalOf(t, 'x', 'mg')).toBe(1500.25);
    expect(totalOf(t, 'x', 'g')).toBe(1.50025);
  });
  it('gives the same total whatever order the stack is in', () => {
    const stack = [item('a', { ingredients: [ing('x', 1, 'g')] }), item('b', { ingredients: [ing('x', 500)] })];
    const forward = ingredientTotals(stack, 'lift');
    const reversed = ingredientTotals([...stack].reverse(), 'lift');
    expect(totalOf(forward, 'x', 'mg')).toBe(1500);
    expect(reversed[0]?.ng).toBe(forward[0]?.ng);
  });
  it('sums grams without floating-point drift', () => {
    const stack = [item('a', { ingredients: [ing('k', 1.2, 'g')] }), item('b', { ingredients: [ing('k', 2.2, 'g')] })];
    expect(totalOf(ingredientTotals(stack, 'lift'), 'k', 'mg')).toBe(3400);
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
