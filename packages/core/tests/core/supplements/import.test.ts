import {
  applyImportReview,
  canonicalProductUrl,
  defaultDecisions,
  mapSupplementSheet,
  timingSlot,
} from '../../../src/supplements/import';

const HEADER = ['Compound', 'Amount', 'Timing', 'Purpose', 'Notes'];
const sheet = (rows: string[][], links: Record<string, string> = {}) => {
  const all = [HEADER, ...rows];
  return { rows: all, links: all.map((r, i) => r.map((_, c) => links[`${i}:${c}`] ?? '')) };
};

describe('timingSlot', () => {
  it.each([
    ['bedtime', 'pm'],
    ['pre-bed', 'pm'],
    ['preworkout', 'pre'],
    ['pre-workout', 'pre'],
    ['preworkout/anytime', 'pre'],
    ['post-workout', 'post'],
    ['postworkout', 'post'],
    ['peri-workout, post-workout', 'post'],
    ['postworkout/fasted/anytime', 'post'],
    ['anytime', 'all'],
  ])('%s -> %s', (text, slot) => expect(timingSlot(text)).toBe(slot));

  it.each(['TID', 'BID', '(1.5-2g/BID/TID)', 'fasted or 2 hours post-meal', 'when anxious/bedtime', 'preworkout/TID', 'peri-workout', ''])(
    '%j stays text',
    (text) => expect(timingSlot(text)).toBeUndefined(),
  );
});

describe('canonicalProductUrl', () => {
  it('reduces an Amazon /gp/product link to /dp/<ASIN>', () => {
    expect(canonicalProductUrl('https://www.amazon.com/gp/product/B000GZSJEM/ref=ppx_yo_dt_b_asin_title_o00_s00?ie=UTF8&psc=1&tag=x-20')).toBe(
      'https://www.amazon.com/dp/B000GZSJEM',
    );
    expect(canonicalProductUrl('https://www.amazon.com/Some-Name/dp/B000GZSJEM/ref=sr_1_3?keywords=creatine')).toBe(
      'https://www.amazon.com/dp/B000GZSJEM',
    );
  });
  it('strips tracking parameters and keeps the rest', () => {
    expect(canonicalProductUrl('https://example.com/p/1?utm_source=a&color=red&fbclid=z#top')).toBe('https://example.com/p/1?color=red');
  });
  it('rejects non-http links', () => {
    expect(canonicalProductUrl('javascript:alert(1)')).toBeUndefined();
    expect(canonicalProductUrl('not a url')).toBeUndefined();
  });
});

describe('mapSupplementSheet (Nutrition_2026 › Supplements layout)', () => {
  const rows = mapSupplementSheet(
    sheet(
      [
        ['Magnesium glycinate', '100-400mg', 'bedtime', 'sleep induction', '>400mg counterproductive'],
        ['Potassium', '1000mg', 'TID w/ food', 'basic muscle function', 'Cannot take all at once'],
        ['Nutricost: PRE-X', '', '', '', ''],
        ['Nitrates', '???', '???', 'exercise agonist', ''],
        ['Creatine monohydrate', '3-5g', 'preworkout/anytime', 'protein synthesis', 'N/A'],
        ['Beta-alanine', '3-6g', '(1.5-2g/BID/TID)', 'fatigue', ''],
        ['Beta-alanine', '1.5g', 'bedtime', '', ''],
        ['', '', '', '', ''],
      ],
      { '1:0': 'https://www.amazon.com/gp/product/B000GZSJEM/ref=x?th=1' },
    ),
  );

  it('maps a row: name, amount and timing into a first dose, purpose, notes, link', () => {
    const mag = rows[0]!;
    expect(mag).toMatchObject({
      name: 'Magnesium glycinate',
      timing: 'bedtime',
      longNote: '>400mg counterproductive',
      doses: [{ slot: 'pm', amount: '100-400mg', servings: 1, dayTypes: [] }],
      links: [{ label: '', url: 'https://www.amazon.com/dp/B000GZSJEM' }],
    });
  });
  it('keeps unrecognised timing as text with no dose, and blanks placeholders', () => {
    expect(rows[1]).toMatchObject({ name: 'Potassium', timing: 'TID w/ food', doses: [] });
    expect(rows[3]).toMatchObject({ name: 'Nitrates', timing: '', doses: [] });
  });
  it('takes the first recognisable timing phrase and uses the catalog by name or alias', () => {
    const creatine = rows[4]!;
    expect(creatine.doses[0]?.slot).toBe('pre');
    expect(creatine.catalogKey).toBeDefined();
    // The catalog has uses for it, so the sheet's Purpose is not copied.
    expect(creatine.shortNote).toBe('');
    expect(creatine.longNote).toBe('');
  });
  it('puts Purpose in the short note when the item has no catalog entry', () => {
    expect(rows[3]?.catalogKey).toBeUndefined();
    expect(rows[3]?.shortNote).toBe('exercise agonist');
  });
  it('flags a repeated name and skips blank rows', () => {
    expect(rows).toHaveLength(7);
    expect(rows[5]?.duplicateOf).toBeUndefined();
    expect(rows[6]?.duplicateOf).toBe(5);
  });
  it('returns nothing when no header names a Compound column', () => {
    expect(mapSupplementSheet({ rows: [['a', 'b']], links: [['', '']] })).toEqual([]);
  });
});

describe('applyImportReview', () => {
  const c = mapSupplementSheet(
    sheet([
      ['Beta-alanine', '3-6g', 'TID', '', ''],
      ['Beta-alanine', '1.5g', 'bedtime', '', 'split it'],
      ['Probiotic', '', '', '', ''],
    ]),
  );
  it('starts a name-only row as pending', () => {
    expect(defaultDecisions(c)).toEqual(['active', 'active', 'pending']);
  });
  it('keeps both duplicates, or merges one into the other, and leaves skipped rows out', () => {
    expect(applyImportReview(c, ['active', 'active', 'skip'])).toHaveLength(2);
    const merged = applyImportReview(c, ['active', 'merge', 'pending']);
    expect(merged.map((r) => r.status)).toEqual(['active', 'pending']);
    expect(merged[0]).toMatchObject({ timing: 'TID; bedtime', longNote: 'split it', doses: [{ slot: 'pm' }] });
  });
});
