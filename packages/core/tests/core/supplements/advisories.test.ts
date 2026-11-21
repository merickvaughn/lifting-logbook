import {
  ADVISORY_INGREDIENTS,
  adaptogenAtNight,
  advisories,
  advisoryContext,
  advisoryCoversDose,
  highCaffeine,
  highPotassium,
  lateStimulant,
  missingAmount,
  type AdvisoryOptions,
  type Placement,
} from '@src/core';
import type { SupplementDayType, SupplementItem } from '@lifting-logbook/types';
import { LIFT, dose, ing, item } from './supplementFixtures';

const ctx = (stack: SupplementItem[], dayType: SupplementDayType = LIFT, options: AdvisoryOptions = {}) =>
  advisoryContext(stack, dayType, options);

const caffeinated = (mg: number, p: Partial<SupplementItem> = {}) =>
  item('c', { ingredients: [ing('caffeine', mg)], ...p });
const at = (sessionTime: string): SupplementDayType => ({ ...LIFT, sessionTime });

describe('lateStimulant', () => {
  it('fires for a session after the cutoff and not at or before it', () => {
    expect(lateStimulant.evaluate(ctx([caffeinated(100)], at('14:01')))?.itemIds).toEqual(['c']);
    expect(lateStimulant.evaluate(ctx([caffeinated(100)], at('14:00')))).toBeNull();
    expect(lateStimulant.evaluate(ctx([caffeinated(100)], at('09:00')))).toBeNull();
  });
  it('uses the cutoff it is given', () => {
    const threePm = { caffeineCutoff: '15:00' };
    expect(lateStimulant.evaluate(ctx([caffeinated(100)], at('14:30'), threePm))).toBeNull();
    expect(lateStimulant.evaluate(ctx([caffeinated(100)], at('15:30'), threePm))?.message).toMatch(/cutoff 15:00/);
  });
  it('does not fire on a day with no session', () => {
    expect(lateStimulant.evaluate(ctx([caffeinated(100)], { id: 'lift', name: 'Lift day' }))).toBeNull();
  });
});

describe('advisoryContext', () => {
  it('rejects a malformed session time or cutoff', () => {
    expect(() => advisoryContext([], at('9:00'))).toThrow(RangeError);
    expect(() => advisoryContext([], at('4:30 PM'))).toThrow(RangeError);
    expect(() => advisoryContext([], LIFT, { caffeineCutoff: '3:00 PM' })).toThrow(RangeError);
  });
  it('leaves pending and unverified items out of every rule', () => {
    const stack = [
      caffeinated(400, { id: 'p', status: 'pending', doses: [dose({ amount: '' })] }),
      caffeinated(400, { id: 'u', unverified: true }),
    ];
    const c = ctx(stack, at('18:00'));
    expect(c.placements).toEqual([]);
    expect(advisories(stack, at('18:00'))).toEqual([]);
  });
});

describe('highCaffeine', () => {
  it('fires at 350 mg and not below', () => {
    expect(highCaffeine.evaluate(ctx([caffeinated(350)]))?.itemIds).toEqual(['c']);
    expect(highCaffeine.evaluate(ctx([caffeinated(349)]))).toBeNull();
  });
  it('fires at exactly 350 mg written in grams', () => {
    const g = (id: string, amount: number) => item(id, { ingredients: [ing('caffeine', amount, 'g')] });
    expect(highCaffeine.evaluate(ctx([g('a', 0.1), g('b', 0.25)]))?.itemIds).toEqual(['a', 'b']);
  });
});

describe('highPotassium', () => {
  const k = (mg: number) => item('k', { ingredients: [ing('potassium', mg)] });
  it('fires above 3,400 mg and not at it', () => {
    const a = highPotassium.evaluate(ctx([k(3401)]));
    expect(a?.itemIds).toEqual(['k']);
    expect(a?.message).toMatch(/spreading it through the day is fine/);
    expect(highPotassium.evaluate(ctx([k(3400)]))).toBeNull();
  });
  it('does not fire at exactly 3,400 mg written in grams', () => {
    const g = (id: string, amount: number) => item(id, { ingredients: [ing('potassium', amount, 'g')] });
    expect(highPotassium.evaluate(ctx([g('a', 1.2), g('b', 2.2)]))).toBeNull();
    expect(highPotassium.evaluate(ctx([g('a', 1.2), g('b', 2.201)]))?.itemIds).toEqual(['a', 'b']);
  });
});

describe('adaptogenAtNight', () => {
  const adaptogen = (key: string, slot: 'pm' | 'am') =>
    item(key, { ingredients: [ing(key, 300)], doses: [dose({ slot, dayTypes: [] })] });
  it('fires for ashwagandha in pm and not in am', () => {
    expect(adaptogenAtNight.evaluate(ctx([adaptogen('ashwagandha', 'pm')]))?.itemIds).toEqual(['ashwagandha']);
    expect(adaptogenAtNight.evaluate(ctx([adaptogen('ashwagandha', 'am')]))).toBeNull();
  });
  it('fires for maca in pm and not in am', () => {
    expect(adaptogenAtNight.evaluate(ctx([adaptogen('maca', 'pm')]))?.itemIds).toEqual(['maca']);
    expect(adaptogenAtNight.evaluate(ctx([adaptogen('maca', 'am')]))).toBeNull();
  });
});

describe('missingAmount', () => {
  it('fires for a blank amount and not a filled one', () => {
    expect(missingAmount.evaluate(ctx([item('a', { doses: [dose({ amount: '' })] })]))?.itemIds).toEqual(['a']);
    expect(missingAmount.evaluate(ctx([item('a')]))).toBeNull();
  });
});

describe('advisories', () => {
  it('runs every rule', () => {
    const r = advisories([caffeinated(400)], LIFT);
    expect(r.map((a) => a.rule)).toEqual(['highCaffeine']);
    expect(r[0]?.source).toBe('fda-caffeine');
  });
  it('passes the cutoff through', () => {
    expect(advisories([caffeinated(100)], at('14:30')).map((a) => a.rule)).toEqual(['lateStimulant']);
    expect(advisories([caffeinated(100)], at('14:30'), { caffeineCutoff: '15:00' })).toEqual([]);
  });
});

describe('advisoryCoversDose', () => {
  const p = (d: Partial<Parameters<typeof dose>[0]> = {}): Placement => ({ item: item('x'), dose: dose(d), counted: true });
  it('puts each rule on the doses it is about', () => {
    expect(advisoryCoversDose('lateStimulant', p({ slot: 'pre' }))).toBe(true);
    expect(advisoryCoversDose('lateStimulant', p({ slot: 'am', dayTypes: [] }))).toBe(false);
    expect(advisoryCoversDose('adaptogenAtNight', p({ slot: 'pm', dayTypes: [] }))).toBe(true);
    expect(advisoryCoversDose('adaptogenAtNight', p({ slot: 'am', dayTypes: [] }))).toBe(false);
    expect(advisoryCoversDose('missingAmount', p({ amount: ' ' }))).toBe(true);
    expect(advisoryCoversDose('missingAmount', p())).toBe(false);
    expect(advisoryCoversDose('highCaffeine', p({ slot: 'am', dayTypes: [] }))).toBe(true);
  });
});

describe('ADVISORY_INGREDIENTS', () => {
  it('names the ingredients that make each rule fire', () => {
    const night = dose({ slot: 'pm', dayTypes: [] });
    for (const key of ADVISORY_INGREDIENTS.adaptogenAtNight) {
      expect(adaptogenAtNight.evaluate(ctx([item('a', { ingredients: [ing(key, 300)], doses: [night] })]))).not.toBeNull();
    }
    for (const key of ADVISORY_INGREDIENTS.highCaffeine) {
      expect(highCaffeine.evaluate(ctx([item('c', { ingredients: [ing(key, 400)] })]))).not.toBeNull();
    }
    for (const key of ADVISORY_INGREDIENTS.highPotassium) {
      expect(highPotassium.evaluate(ctx([item('k', { ingredients: [ing(key, 3500)] })]))).not.toBeNull();
    }
    expect(adaptogenAtNight.evaluate(ctx([item('g', { ingredients: [ing('glycine', 3000)], doses: [night] })]))).toBeNull();
  });
});
