import { validateSupplementSuggestion } from './supplement-suggestion-validation';

const good = {
  name: 'Creatine monohydrate',
  keyCompound: 'Creatine',
  suggestedDose: '1 scoop (5 g)',
  timing: 'Any time',
  suggestedSlot: 'am',
  typicalRange: '3-5 g/day',
  ingredients: [{ key: 'Creatine', amount: 5, unit: 'g' }],
  sources: [{ label: 'Example', url: 'https://example.org/creatine' }],
};

describe('validateSupplementSuggestion (#1381)', () => {
  it('accepts a well-formed reply, as an object or as JSON text', () => {
    const expected = { ...good, ingredients: [{ key: 'creatine', amount: 5, unit: 'g' }], productType: '', sources: [{ label: 'Example', url: 'https://example.org/creatine' }] };
    expect(validateSupplementSuggestion({ suggestion: good })).toEqual(expected);
    expect(validateSupplementSuggestion(JSON.stringify({ suggestion: good }))).toEqual(expected);
  });

  it.each([
    ['text that is not JSON', 'no idea'],
    ['null', null],
    ['an explicit null suggestion', { suggestion: null }],
    ['a suggestion that is an array', { suggestion: [] }],
    ['no name', { suggestion: { ...good, name: '   ' } }],
    ['a non-string name', { suggestion: { ...good, name: 5 } }],
    ['the wrong top-level shape', { suggestions: [good] }],
  ])('rejects %s', (_label, reply) => {
    expect(validateSupplementSuggestion(reply)).toBeNull();
  });

  it('keeps only https sources', () => {
    const out = validateSupplementSuggestion({
      suggestion: {
        ...good,
        sources: [
          { label: 'http', url: 'http://example.org/a' },
          { label: 'js', url: 'javascript:alert(1)' },
          { label: 'creds', url: 'https://user:pw@example.org/' },
          { label: 'nohost', url: 'https://localhost/' },
          { label: 'junk', url: 'not a url' },
          { label: 'ok', url: 'https://example.org/ok' },
        ],
      },
    });
    expect(out?.sources).toEqual([{ label: 'ok', url: 'https://example.org/ok' }]);
  });

  it('drops ingredients with a bad unit or amount, clips text, and defaults an unknown slot', () => {
    const out = validateSupplementSuggestion({
      suggestion: {
        ...good,
        name: 'n'.repeat(500),
        suggestedSlot: 'midnight',
        ingredients: [
          { key: 'a', amount: 1, unit: 'IU' },
          { key: 'b', amount: -1, unit: 'mg' },
          { key: 'c', amount: '5', unit: 'mg' },
          { key: 'd', amount: 1e12, unit: 'mg' },
          { key: '', amount: 1, unit: 'mg' },
          { key: 'Vitamin C', amount: 90, unit: 'mg' },
        ],
      },
    });
    expect(out?.name).toHaveLength(200);
    expect(out?.suggestedSlot).toBe('all');
    expect(out?.ingredients).toEqual([{ key: 'vitamin-c', amount: 90, unit: 'mg' }]);
  });

  it('keeps at most 12 ingredients and 3 sources', () => {
    const out = validateSupplementSuggestion({
      suggestion: {
        ...good,
        ingredients: Array.from({ length: 30 }, (_, i) => ({ key: `i${i}`, amount: 1, unit: 'mg' })),
        sources: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, url: `https://example.org/${i}` })),
      },
    });
    expect(out?.ingredients).toHaveLength(12);
    expect(out?.sources).toHaveLength(3);
  });
});
