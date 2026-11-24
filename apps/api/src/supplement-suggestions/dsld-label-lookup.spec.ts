import { readFileSync } from 'fs';
import { join } from 'path';
import { DsldLabelLookup, DsldUnavailableError, OUTAGE_BACKOFF_MS, dsldUnit, labelToSuggestion } from './dsld-label-lookup';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
// Recorded from https://api.ods.od.nih.gov/dsld/v9 (search-filter?q=creatine&size=3, then each
// hit's label/{id}) and trimmed to the fields the adapter reads.
const answers: Record<string, unknown> = {
  '/search-filter': fixture('dsld-search-creatine.json'),
  '/label/43261': fixture('dsld-label-43261.json'),
  '/label/25731': fixture('dsld-label-25731.json'),
  '/label/31127': fixture('dsld-label-31127.json'),
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

const searchCalls = (fetchFn: jest.Mock) => fetchFn.mock.calls.filter(([url]) => String(url).includes('/search-filter')).length;

describe('DsldLabelLookup (#1381, recorded fixtures, no network)', () => {
  it('maps labels to catalog-shaped suggestions with the label as the source', async () => {
    const fetchFn = fakeFetch();
    const found = await new DsldLabelLookup(fetchFn).lookup('Creatine');

    expect(fetchFn.mock.calls[0]?.[0]).toBe('https://api.ods.od.nih.gov/dsld/v9/search-filter?q=Creatine&size=3');
    expect(found.map((f) => f.name)).toEqual(['Creatine Alkaline', 'Creatine Alkaline', 'Creatine Fruit Punch']);
    expect(found[0]).toEqual({
      name: 'Creatine Alkaline',
      keyCompound: 'Creatine',
      suggestedDose: '2 capsule',
      timing: '',
      suggestedSlot: 'all',
      typicalRange: '',
      ingredients: [{ key: 'creatine', amount: 1.5, unit: 'g' }],
      productType: 'Non-Nutrient/Non-Botanical',
      sources: [{ label: 'NIH Dietary Supplement Label Database', url: 'https://dsld.od.nih.gov/label/43261' }],
    });
    expect(found[1]?.ingredients).toEqual([{ key: 'creatine', amount: 1500, unit: 'mg' }]);
    expect(found[1]?.sources[0]?.url).toBe('https://dsld.od.nih.gov/label/25731');
    // A powder: the serving is in grams, and the rows in calories or "NP" (not present) are left out.
    expect(found[2]).toMatchObject({
      suggestedDose: '10.67 gram',
      keyCompound: 'Calories',
      productType: 'Other Combinations',
      ingredients: [
        { key: 'total-carbohydrates', amount: 3, unit: 'g' },
        { key: 'calcium', amount: 40, unit: 'mg' },
        { key: 'phosphorus', amount: 70, unit: 'mg' },
        { key: 'magnesium', amount: 120, unit: 'mg' },
        { key: 'sodium', amount: 10, unit: 'mg' },
        { key: 'potassium', amount: 60, unit: 'mg' },
      ],
    });
  });

  it('leaves out an IU row: the app counts mg, g and mcg only', () => {
    // Synthetic, hand-written fixture: none of the recorded creatine labels has an IU row.
    expect(labelToSuggestion('900001', fixture('dsld-label-synthetic-iu.json'))?.ingredients).toEqual([
      { key: 'vitamin-k2', amount: 90, unit: 'mcg' },
    ]);
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

  it('evicts the least recently used name, not the oldest one added', async () => {
    const fetchFn = fakeFetch({ '/search-filter': { hits: [] } });
    const lookup = new DsldLabelLookup(fetchFn);
    for (let i = 0; i < 200; i++) await lookup.lookup(`name ${i}`);
    await lookup.lookup('name 0'); // a hit: now the most recently used
    await lookup.lookup('name 200'); // the 201st name evicts one
    const before = fetchFn.mock.calls.length;
    await lookup.lookup('name 0'); // kept, though it was added first
    expect(fetchFn.mock.calls.length).toBe(before);
    await lookup.lookup('name 1'); // the least recently used: evicted
    expect(fetchFn.mock.calls.length).toBe(before + 1);
  });

  it('returns nothing for a search with no hits, and skips a label that names nothing', async () => {
    expect(await new DsldLabelLookup(fakeFetch({ '/search-filter': { hits: [] } })).lookup('zzz')).toEqual([]);
    const found = await new DsldLabelLookup(fakeFetch({ '/label/25731': { id: 25731 } })).lookup('Creatine');
    expect(found.map((f) => f.sources[0]?.url)).toEqual(['https://dsld.od.nih.gov/label/43261', 'https://dsld.od.nih.gov/label/31127']);
  });

  it('keeps the labels that answered when one label fails', async () => {
    const found = await new DsldLabelLookup(fakeFetch({ '/label/25731': 503, '/label/31127': new Error('ECONNRESET') })).lookup('Creatine');
    expect(found.map((f) => f.sources[0]?.url)).toEqual(['https://dsld.od.nih.gov/label/43261']);
  });

  it('rejects when every label fails', async () => {
    const fetchFn = fakeFetch({ '/label/43261': 503, '/label/25731': 503, '/label/31127': new Error('ECONNRESET') });
    await expect(new DsldLabelLookup(fetchFn).lookup('Creatine')).rejects.toThrow('DSLD HTTP 503');
  });

  it('rejects on an HTTP error or a network failure, and does not cache the failure', async () => {
    await expect(new DsldLabelLookup(fakeFetch({ '/search-filter': 503 })).lookup('Creatine')).rejects.toThrow('DSLD HTTP 503');
    let now = 0;
    const fetchFn = fakeFetch({ '/search-filter': new Error('ECONNRESET') });
    const lookup = new DsldLabelLookup(fetchFn, () => now);
    await expect(lookup.lookup('Creatine')).rejects.toThrow('ECONNRESET');
    now = OUTAGE_BACKOFF_MS;
    await expect(lookup.lookup('Creatine')).rejects.toThrow('ECONNRESET');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('after a failure, rejects every lookup without calling until the back-off ends', async () => {
    let now = 0;
    const fetchFn = fakeFetch({ '/search-filter': 503 });
    const lookup = new DsldLabelLookup(fetchFn, () => now);
    await expect(lookup.lookup('Creatine')).rejects.toThrow('DSLD HTTP 503');
    now = OUTAGE_BACKOFF_MS - 1;
    await expect(lookup.lookup('Creatine')).rejects.toBeInstanceOf(DsldUnavailableError);
    await expect(lookup.lookup('Taurine')).rejects.toBeInstanceOf(DsldUnavailableError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now = OUTAGE_BACKOFF_MS;
    await expect(lookup.lookup('Taurine')).rejects.toThrow('DSLD HTTP 503');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('shares one request between identical lookups in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = fakeFetch();
    const fetchFn = jest.fn(async (url: string, init: { signal: AbortSignal }) => {
      await gate;
      return base(url, init);
    });
    const lookup = new DsldLabelLookup(fetchFn);
    const both = Promise.all([lookup.lookup('Creatine'), lookup.lookup(' creatine ')]);
    release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(searchCalls(fetchFn)).toBe(1);
    // Once settled, the next lookup is a cache hit, not a second shared request.
    await lookup.lookup('Creatine');
    expect(searchCalls(fetchFn)).toBe(1);
  });

  it('sends only the length-capped typed name', async () => {
    const fetchFn = fakeFetch({ '/search-filter': { hits: [] } });
    await new DsldLabelLookup(fetchFn).lookup(`${'a'.repeat(200)}\nsecond line`);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`https://api.ods.od.nih.gov/dsld/v9/search-filter?q=${'a'.repeat(80)}&size=3`);
  });

  it('sends a name cut just after an emoji without a URI error', async () => {
    const fetchFn = fakeFetch({ '/search-filter': { hits: [] } });
    await expect(new DsldLabelLookup(fetchFn).lookup(`${'a'.repeat(79)}\u{1F4AA}more`)).resolves.toEqual([]);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `https://api.ods.od.nih.gov/dsld/v9/search-filter?q=${'a'.repeat(79)}${encodeURIComponent('\u{1F4AA}')}&size=3`,
    );
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
    ['{Calories}', null],
    ['NP', null],
    [undefined, null],
  ])('reads the unit %s as %s', (unit, expected) => {
    expect(dsldUnit(unit)).toBe(expected);
  });
});
