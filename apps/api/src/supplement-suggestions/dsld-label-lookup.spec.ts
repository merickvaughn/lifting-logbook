import { readFileSync } from 'fs';
import { join } from 'path';
import { DsldLabelLookup, dsldUnit } from './dsld-label-lookup';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const answers: Record<string, unknown> = {
  '/search-filter': fixture('dsld-search-creatine.json'),
  '/label/900001': fixture('dsld-label-900001.json'),
  '/label/900002': fixture('dsld-label-900002.json'),
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function fakeFetch(overrides: Record<string, unknown> = {}) {
  return jest.fn(async (url: string) => {
    const path = url.replace('https://api.ods.od.nih.gov/dsld/v9', '').split('?')[0] ?? '';
    const body = path in overrides ? overrides[path] : answers[path];
    if (body instanceof Error) throw body;
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
    return ok(body);
  });
}

describe('DsldLabelLookup (#1381, recorded-shape fixtures, no network)', () => {
  it('maps labels to catalog-shaped suggestions with the label as the source', async () => {
    const fetchFn = fakeFetch();
    const found = await new DsldLabelLookup(fetchFn).lookup('Creatine');

    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.ods.od.nih.gov/dsld/v9/search-filter?q=Creatine&size=3');
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      name: 'Creatine Monohydrate Powder',
      keyCompound: 'Creatine Monohydrate',
      suggestedDose: '1 scoop',
      timing: '',
      suggestedSlot: 'all',
      typicalRange: '',
      // The IU row is left out: the app counts mg, g and mcg only.
      ingredients: [
        { key: 'creatine-monohydrate', amount: 5, unit: 'g' },
        { key: 'vitamin-b6', amount: 2, unit: 'mg' },
        { key: 'folate', amount: 100, unit: 'mcg' },
      ],
      productType: 'Amino acid/Protein [A1305]',
      sources: [{ label: 'NIH Dietary Supplement Label Database', url: 'https://dsld.od.nih.gov/label/900001' }],
    });
    expect(found[1]?.suggestedDose).toBe('2 capsule');
    expect(found[1]?.ingredients).toEqual([{ key: 'creatine-monohydrate', amount: 1500, unit: 'mg' }]);
  });

  it('caches by name, ignoring case, and expires entries', async () => {
    const fetchFn = fakeFetch();
    let now = 0;
    const lookup = new DsldLabelLookup(fetchFn, () => now);
    await lookup.lookup('Creatine');
    const calls = fetchFn.mock.calls.length;
    await lookup.lookup('creatine');
    expect(fetchFn.mock.calls.length).toBe(calls);
    now = 7 * 60 * 60_000;
    await lookup.lookup('Creatine');
    expect(fetchFn.mock.calls.length).toBe(calls * 2);
  });

  it('keeps the cache bounded', async () => {
    const fetchFn = fakeFetch({ '/search-filter': { hits: [] } });
    const lookup = new DsldLabelLookup(fetchFn);
    for (let i = 0; i < 205; i++) await lookup.lookup(`name ${i}`);
    const before = fetchFn.mock.calls.length;
    await lookup.lookup('name 0'); // evicted: fetched again
    expect(fetchFn.mock.calls.length).toBe(before + 1);
    await lookup.lookup('name 204'); // still cached
    expect(fetchFn.mock.calls.length).toBe(before + 1);
  });

  it('returns nothing for a search with no hits, and skips a label that names nothing', async () => {
    expect(await new DsldLabelLookup(fakeFetch({ '/search-filter': { hits: [] } })).lookup('zzz')).toEqual([]);
    const found = await new DsldLabelLookup(fakeFetch({ '/label/900002': { id: 900002 } })).lookup('Creatine');
    expect(found.map((f) => f.name)).toEqual(['Creatine Monohydrate Powder']);
  });

  it('rejects on an HTTP error or a network failure, and does not cache the failure', async () => {
    await expect(new DsldLabelLookup(fakeFetch({ '/search-filter': 503 })).lookup('Creatine')).rejects.toThrow('DSLD HTTP 503');
    const fetchFn = fakeFetch({ '/search-filter': new Error('ECONNRESET') });
    const lookup = new DsldLabelLookup(fetchFn);
    await expect(lookup.lookup('Creatine')).rejects.toThrow('ECONNRESET');
    await expect(lookup.lookup('Creatine')).rejects.toThrow('ECONNRESET');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('sends only the length-capped typed name', async () => {
    const fetchFn = fakeFetch({ '/search-filter': { hits: [] } });
    await new DsldLabelLookup(fetchFn).lookup(`${'a'.repeat(200)}\nsecond line`);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`https://api.ods.od.nih.gov/dsld/v9/search-filter?q=${'a'.repeat(80)}&size=3`);
  });

  it.each([
    ['Milligram(s)', 'mg'],
    ['mg', 'mg'],
    ['Gram(s)', 'g'],
    ['Microgram(s)', 'mcg'],
    ['mcg RAE', 'mcg'],
    ['µg', 'mcg'],
    ['IU', null],
    ['CFU', null],
    [undefined, null],
  ])('reads the unit %s as %s', (unit, expected) => {
    expect(dsldUnit(unit)).toBe(expected);
  });
});
