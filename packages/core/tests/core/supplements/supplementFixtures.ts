import type {
  Ingredient,
  SupplementChange,
  SupplementDayType,
  SupplementDose,
  SupplementItem,
} from '@lifting-logbook/types';

export const LIFT: SupplementDayType = { id: 'lift', name: 'Lift day', sessionTime: '07:00' };
export const REST: SupplementDayType = { id: 'rest', name: 'Rest day' };

export const dose = (p: Partial<SupplementDose> = {}): SupplementDose => ({
  slot: 'pre',
  amount: '1 scoop',
  servings: 1,
  dayTypes: ['lift'],
  ...p,
});

export const ing = (key: string, amount: number, unit: Ingredient['unit'] = 'mg'): Ingredient => ({
  key,
  amount,
  unit,
});

export function item(id: string, p: Partial<SupplementItem> = {}): SupplementItem {
  return {
    id,
    name: id,
    keyCompound: '',
    timing: '',
    shortNote: '',
    longNote: '',
    status: 'active',
    unverified: false,
    links: [],
    category: '',
    typicalRange: '',
    ingredients: [],
    doses: [dose()],
    ...p,
  };
}

type WithoutSeq<C> = C extends unknown ? Omit<C, 'seq'> : never;

/** A change log whose `seq` follows the order the changes are written in. */
export const changeLog = (...changes: WithoutSeq<SupplementChange>[]): SupplementChange[] =>
  changes.map((c, seq) => ({ ...c, seq }));
