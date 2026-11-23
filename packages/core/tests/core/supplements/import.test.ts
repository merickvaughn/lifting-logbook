import {
  applyImportReview,
  canonicalProductUrl,
  defaultDecisions,
  mapSupplementSheet,
  timingSlot,
} from '../../../src/supplements/import';
import { SUPPLEMENT_TEXT_MAX } from '@lifting-logbook/types';

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
  it('reads Amazon only on its retail domains, with or without www', () => {
    expect(canonicalProductUrl('https://amazon.co.uk/dp/B000GZSJEM?tag=x')).toBe('https://www.amazon.co.uk/dp/B000GZSJEM');
    expect(canonicalProductUrl('https://www.amazon.com.au/gp/product/b000gzsjem')).toBe('https://www.amazon.com.au/dp/B000GZSJEM');
    // Not Amazon, so not rewritten to an Amazon URL; its tracking still goes.
    expect(canonicalProductUrl('https://amazon.com.evil.net/dp/B000GZSJEM?tag=x')).toBe('https://amazon.com.evil.net/dp/B000GZSJEM');
    expect(canonicalProductUrl('https://smile.amazon.com.evil.net/dp/B000GZSJEM')).toBe('https://smile.amazon.com.evil.net/dp/B000GZSJEM');
  });
  it('drops a user name and password from any link', () => {
    expect(canonicalProductUrl('https://me:secret@example.com/p/1')).toBe('https://example.com/p/1');
    expect(canonicalProductUrl('https://me:secret@www.amazon.de/dp/B000GZSJEM')).toBe('https://www.amazon.de/dp/B000GZSJEM');
  });
  it('drops a link the item form would refuse: no dotted host, localhost, an IP, or too long', () => {
    expect(canonicalProductUrl('https://intranet/p/1')).toBeUndefined();
    expect(canonicalProductUrl('http://localhost:3000/p/1')).toBeUndefined();
    expect(canonicalProductUrl('http://192.168.0.1/p/1')).toBeUndefined();
    expect(canonicalProductUrl('ftp://example.com/p/1')).toBeUndefined();
    expect(canonicalProductUrl(`https://example.com/${'a'.repeat(2000)}`)).toBeUndefined();
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
    const mag = rows[0];
    expect(mag).toMatchObject({
      name: 'Magnesium glycinate',
      timing: 'bedtime',
      longNote: '>400mg counterproductive',
      doses: [{ slot: 'pm', amount: '100-400mg', servings: 1, dayTypes: [] }],
      links: [{ label: '', url: 'https://www.amazon.com/dp/B000GZSJEM' }],
    });
  });
  it('keeps unrecognised timing as text with no dose, and blanks placeholders', () => {
    expect(rows[1]).toMatchObject({ name: 'Potassium', amount: '1000mg', timing: 'TID w/ food', doses: [] });
    expect(rows[3]).toMatchObject({ name: 'Nitrates', amount: '', timing: '', doses: [] });
  });
  it('numbers each row as the sheet does', () => {
    expect(rows.map((r) => r.sheetRow)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    const gap = mapSupplementSheet({ ...sheet([['Iron', '18mg', '', '', '']]), rowNumbers: [1, 4] });
    expect(gap[0]?.sheetRow).toBe(4);
  });
  it('matches the catalog by an alias', () => {
    const [alcar] = mapSupplementSheet(sheet([['ALCAR', '630-2500mg', 'anytime', 'recovery', '']]));
    expect(alcar?.catalogKey).toBe('acetyl-l-carnitine');
  });
  it('cuts a long name, timing or note to what the import endpoint accepts', () => {
    const c = mapSupplementSheet(sheet([['N'.repeat(300), 'A'.repeat(300), 'T'.repeat(300), 'P'.repeat(3000), 'L'.repeat(3000)]]));
    const [long] = c;
    expect(long?.name).toHaveLength(SUPPLEMENT_TEXT_MAX.name);
    expect(long?.amount).toHaveLength(SUPPLEMENT_TEXT_MAX.name);
    expect(long?.timing).toHaveLength(SUPPLEMENT_TEXT_MAX.name);
    expect(long?.shortNote).toHaveLength(SUPPLEMENT_TEXT_MAX.text);
    expect(long?.longNote).toHaveLength(SUPPLEMENT_TEXT_MAX.text);
    const [row] = applyImportReview(c, ['active']);
    // The amount goes in front of the timing, still within the limit.
    expect(row?.timing).toHaveLength(SUPPLEMENT_TEXT_MAX.name);
  });
  it('drops a link the item form would refuse, keeping the row', () => {
    const [local, noDot] = mapSupplementSheet(
      sheet([['Iron', '', '', '', ''], ['Zinc', '', '', '', '']], { '1:0': 'http://localhost/iron', '2:0': 'https://shop/zinc' }),
    );
    expect(local).toMatchObject({ name: 'Iron', links: [] });
    expect(noDot).toMatchObject({ name: 'Zinc', links: [] });
  });
  it('takes the first recognisable timing phrase and uses the catalog by name or alias', () => {
    const creatine = rows[4];
    expect(creatine?.doses[0]?.slot).toBe('pre');
    expect(creatine?.catalogKey).toBeDefined();
    // The catalog has uses for it, so the sheet's Purpose is not copied.
    expect(creatine?.shortNote).toBe('');
    expect(creatine?.longNote).toBe('');
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
  it('flags a repeat by catalog entry as well as by name', () => {
    const c = mapSupplementSheet(
      sheet([['Creatine monohydrate', '3-5g', '', '', ''], ['Creatine', '5g', '', '', ''], ['Creatine', '3g', '', '', '']]),
    );
    // The third repeats the second by name, and so the first.
    expect(c.map((r) => r.duplicateOf)).toEqual([undefined, 0, 0]);
  });
  it('marks a row whose name or catalog entry is already in the stack, and starts it as skipped', () => {
    const c = mapSupplementSheet(
      sheet([['Iron', '18mg', '', '', ''], ['Creatine', '5g', '', '', ''], ['Zinc', '15mg', '', '', '']]),
      [{ name: 'iron' }, { name: 'My creatine', catalogKey: 'creatine-monohydrate' }],
    );
    expect(c.map((r) => r.inStack)).toEqual([true, true, false]);
    expect(defaultDecisions(c)).toEqual(['skip', 'skip', 'active']);
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
    // The first row has no dose, so its amount stays in its timing text.
    expect(merged[0]).toMatchObject({ timing: '3-6g TID; bedtime', longNote: 'split it', doses: [{ slot: 'pm', amount: '1.5g' }] });
  });
  it('puts the amount in front of the timing when no dose holds it', () => {
    const [potassium, polypodium, iron] = applyImportReview(
      mapSupplementSheet(
        sheet([
          ['Potassium', '1000mg', 'TID w/ food', '', ''],
          ['Polypodium leucotomos', '500-850 mg', '', '', ''],
          ['Iron', '18mg', 'bedtime', '', ''],
        ]),
      ),
      ['active', 'active', 'active'],
    );
    expect(potassium).toMatchObject({ amount: '1000mg', timing: '1000mg TID w/ food', doses: [] });
    expect(polypodium).toMatchObject({ amount: '500-850 mg', timing: '500-850 mg', doses: [] });
    // A dose holds it, so the timing is left as it was.
    expect(iron).toMatchObject({ timing: 'bedtime', doses: [{ slot: 'pm', amount: '18mg' }] });
  });
  it('joins the amounts of two merged doses in the same slot on the one dose', () => {
    const twice = mapSupplementSheet(sheet([['Glycine', '3g', 'bedtime', '', ''], ['Glycine', '2g', 'before bed', '', '']]));
    const [glycine] = applyImportReview(twice, ['active', 'merge']);
    expect(glycine?.doses).toEqual([{ slot: 'pm', amount: '3g + 2g', servings: 1, dayTypes: [] }]);
  });
  it('imports a row merging into a skipped row as its own active row rather than losing it', () => {
    expect(applyImportReview(c, ['skip', 'merge', 'skip'])).toEqual([
      expect.objectContaining({ name: 'Beta-alanine', status: 'active', timing: 'bedtime', longNote: 'split it' }),
    ]);
  });
});
