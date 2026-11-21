import {
  SUPPLEMENT_CATALOG,
  SUPPLEMENT_SOURCES,
  catalogReference,
  findSupplement,
  itemFromCatalog,
  searchSupplements,
  stackAsOf,
  supplementByKey,
  supplementSourceUrl,
  toCatalogEntry,
} from '@src/core';

const SEED = [
  'fish oil', 'calcium', 'potassium', 'sodium', 'magnesium glycinate', 'magnesium citrate', 'magnesium (generic)',
  'multivitamin', 'protein powder (whey)', 'iron', 'iodine', 'zinc', 'selenium', 'ashwagandha', 'melatonin',
  'apple cider vinegar', 'anthocyanins (blueberry extract)', 'curcumin with piperine', 'maca', 'fenugreek',
  'cocoa flavanols', 'creatine monohydrate', 'l-citrulline malate', 'agmatine sulfate', 'beta-alanine',
  'acetyl-l-carnitine', 'l-carnitine l-tartrate', 'taurine', 'coq10', 'l-theanine', 'collagen peptides', 'probiotic',
  'vitamin c', 'polypodium leucotomos', 'dietary nitrate', 'caffeine', 'nutricost pre-x', 'evl trans4orm',
  'evl pump mode', 'quest protein powder',
];

describe('supplement catalog', () => {
  it('has every seed compound and product', () => {
    for (const name of SEED) expect({ name, found: findSupplement(name)?.name }).toEqual({ name, found: expect.any(String) });
  });

  it('has unique keys and no two entries sharing a name or alias', () => {
    const keys = SUPPLEMENT_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const names = SUPPLEMENT_CATALOG.flatMap((e) => [e.name, ...e.aliases].map((n) => n.toLowerCase()));
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every entry a source, and every source key an https URL', () => {
    for (const e of SUPPLEMENT_CATALOG) {
      expect({ key: e.key, sources: e.sources.length > 0 }).toEqual({ key: e.key, sources: true });
      for (const s of e.sources) expect({ key: e.key, url: SUPPLEMENT_SOURCES[s] }).toEqual({ key: e.key, url: expect.stringMatching(/^https:\/\/[^\s]+$/) });
    }
    for (const url of Object.values(SUPPLEMENT_SOURCES)) expect(() => new URL(url)).not.toThrow();
  });

  it('resolves a saved source key to its current URL, and an unknown one to undefined', () => {
    expect(supplementSourceUrl('issn-creatine')).toBe(SUPPLEMENT_SOURCES['issn-creatine']);
    expect(supplementSourceUrl('no-such-source')).toBeUndefined();
    expect(supplementSourceUrl('toString')).toBeUndefined();
  });

  it('fills every reference field of every entry', () => {
    for (const e of SUPPLEMENT_CATALOG) {
      expect(['strong', 'moderate', 'limited']).toContain(e.evidence.level);
      for (const text of [e.evidence.reason, e.typicalRange, e.timing, e.suggestedDose, e.keyCompound]) expect(text.trim()).not.toBe('');
      expect(e.uses.length).toBeGreaterThan(0);
      expect(e.cautions.length).toBeGreaterThan(0);
    }
  });

  it('keeps the product label amounts', () => {
    const amount = (name: string, key: string) => findSupplement(name)?.ingredients.find((i) => i.key === key)?.amount;
    expect(amount('Nutricost Pre-X', 'caffeine')).toBe(300);
    expect(amount('EVL Trans4orm', 'caffeine')).toBe(175);
    expect(amount('Quest protein powder', 'protein')).toBe(24);
    expect(findSupplement('EVL Pump Mode')?.ingredients).toEqual([]);
  });
});

describe('findSupplement and searchSupplements', () => {
  it('finds by name or alias, ignoring case and outer spaces', () => {
    const a = findSupplement('creatine');
    expect(a).toBeDefined();
    expect(findSupplement('Creatine Monohydrate')).toBe(a);
    expect(findSupplement('  CREATINE ')).toBe(a);
  });

  it('finds nothing for an unknown or blank name', () => {
    expect(findSupplement('not a supplement')).toBeUndefined();
    expect(findSupplement('  ')).toBeUndefined();
  });

  it('searches by substring with prefix matches first', () => {
    const names = searchSupplements('MAGNES').map((e) => e.key);
    expect(names).toEqual(expect.arrayContaining(['magnesium', 'magnesium-glycinate', 'magnesium-citrate']));
    expect(searchSupplements('carn').map((e) => e.key)).toEqual(expect.arrayContaining(['acetyl-l-carnitine', 'l-carnitine-l-tartrate']));
    expect(searchSupplements('creat')[0]?.key).toBe('creatine-monohydrate');
    expect(searchSupplements('')).toEqual([]);
  });
});

describe('itemFromCatalog', () => {
  const creatine = () => supplementByKey('creatine-monohydrate')!;

  it('copies the reference content and the entry key onto the item', () => {
    const item = itemFromCatalog(creatine(), { name: 'Creatine' });
    expect(item.catalogKey).toBe('creatine-monohydrate');
    expect(item.reference).toEqual(catalogReference(creatine()));
    expect(item.reference?.sources).toEqual(creatine().sources);
    expect(item.ingredients).toEqual([{ key: 'creatine', amount: 5, unit: 'g' }]);
    expect(item.keyCompound).toBe('Creatine');
  });

  it('writes only fields the lifter has not typed', () => {
    const typed = { name: 'My creatine', keyCompound: 'Creatine HCl', timing: '', shortNote: 'with breakfast', ingredients: [{ key: 'creatine', amount: 3, unit: 'g' as const }] };
    const item = itemFromCatalog(creatine(), typed);
    expect(item).toMatchObject({ name: 'My creatine', keyCompound: 'Creatine HCl', shortNote: 'with breakfast', ingredients: typed.ingredients });
    expect(item.timing).toBe(creatine().timing);
  });

  it('is a copy: editing the item or the catalog later does not reach the other', () => {
    const entry = { ...creatine(), uses: ['x'], cautions: ['c'], sources: ['ais' as const], ingredients: [{ key: 'creatine', amount: 5, unit: 'g' as const }] };
    const item = itemFromCatalog(entry);
    item.reference!.uses.push('added by user');
    item.ingredients[0]!.amount = 99;
    expect(entry.uses).toEqual(['x']);
    expect(entry.ingredients[0]!.amount).toBe(5);
    entry.cautions.push('later catalog edit');
    entry.ingredients[0]!.amount = 7;
    expect(item.reference!.cautions).toEqual(['c']);
    expect(item.ingredients[0]!.amount).toBe(99);
  });

  it('keeps the reference through a replayed added change', () => {
    const fields = itemFromCatalog(creatine());
    const item = { id: 'i', status: 'active' as const, unverified: false, doses: [], ...fields };
    const { stack } = stackAsOf([{ date: '2026-01-01', seq: 1, type: 'added', item }], '2026-01-02');
    expect(stack[0]?.reference).toEqual(fields.reference);
    expect(stack[0]?.catalogKey).toBe('creatine-monohydrate');
  });

  it('serves a catalog entry with its reference', () => {
    expect(toCatalogEntry(creatine()).reference.evidence.level).toBe('strong');
  });
});
