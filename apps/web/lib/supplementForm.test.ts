import type { SupplementCatalogEntry } from '@lifting-logbook/types';
import { dose, item } from './__tests__/supplementsTestStack';
import { candidateItem, overlapsFor, sharesLine, sharesSlotWith } from './supplementForm';

describe('supplementForm overlap helpers', () => {
  const citrulline = (amount: number, unit: 'mg' | 'g') => [{ key: 'l-citrulline', amount, unit }];

  it('states each side in the unit that item lists the ingredient in', () => {
    const stack = item('malate', 'L-Citrulline malate', { ingredients: citrulline(4.3, 'g'), doses: [dose('all', '6–7 g')] });
    const candidate = item('', '', { ingredients: citrulline(4000, 'mg'), doses: [dose('pre', '1 scoop', ['lift'])] });
    const [o] = overlapsFor(candidate, [stack]);
    expect(sharesLine(o, candidate, 'lift')).toBe('Shares l-citrulline (4.3 g now; 4,000 mg in this)');
  });

  it('counts only doses with an amount, times their servings, on the day type shown', () => {
    const stack = item('two', 'Two doses', {
      ingredients: citrulline(2, 'g'),
      doses: [dose('am', '1 scoop'), { ...dose('pre', '2 scoops', ['lift']), servings: 2 }, dose('pm', '')],
    });
    const candidate = item('', '', { ingredients: citrulline(1, 'g'), doses: [dose('am', '1 scoop')] });
    const [o] = overlapsFor(candidate, [stack]);
    // Lift day: am 2 g + pre 2 × 2 g; the blank pm dose adds nothing.
    expect(sharesLine(o, candidate, 'lift')).toBe('Shares l-citrulline (6 g now; 1 g in this)');
    // Rest day: only the every-day am dose applies.
    expect(sharesLine(o, candidate, 'rest')).toBe('Shares l-citrulline (2 g now; 1 g in this)');
  });

  it('counts the candidate the same way, even while it is pending', () => {
    const stack = item('malate', 'L-Citrulline malate', { ingredients: citrulline(4, 'g'), doses: [dose('all', '1 scoop')] });
    const candidate = { ...item('', '', { ingredients: citrulline(5, 'g'), doses: [dose('pm', '')] }), status: 'pending' as const };
    const [o] = overlapsFor(candidate, [stack]);
    expect(sharesLine(o, candidate, 'lift')).toBe('Shares l-citrulline (4 g now; 0 g in this)');
  });

  it('candidateItem takes protein from the field, replacing a catalog entry’s, and drops it at 0', () => {
    const entry: SupplementCatalogEntry = {
      key: 'whey',
      name: 'Whey protein',
      aliases: [],
      kind: 'product',
      keyCompound: 'Whey',
      suggestedDose: '1 scoop',
      timing: 'Post-workout',
      suggestedSlot: 'post',
      ingredients: [
        { key: 'protein', amount: 24, unit: 'g' },
        { key: 'leucine', amount: 2, unit: 'g' },
      ],
      reference: { uses: [], evidence: { level: 'strong', reason: 'r' }, cautions: [], typicalRange: '', sources: [] },
    };
    const keyed = (protein: string) => candidateItem({ doses: [], status: 'active', protein }, entry).ingredients;
    expect(keyed('')).toEqual(entry.ingredients);
    expect(keyed('30')).toEqual([{ key: 'leucine', amount: 2, unit: 'g' }, { key: 'protein', amount: 30, unit: 'g' }]);
    expect(keyed('0')).toEqual([{ key: 'leucine', amount: 2, unit: 'g' }]);
  });

  it('sharesSlotWith follows the slot and, in a workout slot, the day types', () => {
    const pre = item('a', 'A', { doses: [dose('pre', '1', ['lift'])] });
    expect(sharesSlotWith(item('', '', { doses: [dose('pre', '1', ['lift'])] }), pre)).toBe(true);
    expect(sharesSlotWith(item('', '', { doses: [dose('pre', '1', ['rest'])] }), pre)).toBe(false);
    expect(sharesSlotWith(item('', '', { doses: [dose('am', '1')] }), pre)).toBe(false);
  });
});
