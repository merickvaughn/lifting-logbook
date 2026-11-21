import type { SupplementDose, SupplementItem } from '@lifting-logbook/types';
import type { Stack } from './supplementsView';

// Test-only fixture: product names and amounts only. Lift day at 16:30, caffeine cutoff 15:00.
const dose = (slot: SupplementDose['slot'], amount: string, dayTypes: string[] = []): SupplementDose => ({
  slot,
  amount,
  servings: 1,
  dayTypes,
});

const item = (id: string, name: string, over: Partial<SupplementItem> = {}): SupplementItem => ({
  id,
  name,
  keyCompound: '',
  timing: '',
  shortNote: '',
  longNote: '',
  status: 'active',
  unverified: false,
  links: [],
  ingredients: [],
  doses: [],
  ...over,
});

export const REFERENCE = {
  uses: ['Alertness before a hard session'],
  evidence: { level: 'strong' as const, reason: 'Caffeine reliably improves performance.' },
  cautions: ['Can disturb sleep when taken late'],
  typicalRange: '100–400 mg',
  sources: ['issn-caffeine'],
};

export const STACK: Stack = {
  caffeineCutoff: '15:00',
  dayTypes: [
    { id: 'lift', name: 'Lift day', sessionTime: '16:30' },
    { id: 'rest', name: 'Rest day' },
  ],
  items: [
    item('pre-x', 'Nutricost Pre-X', {
      keyCompound: '300 mg caffeine · 4 g citrulline',
      timing: '30–60 min before',
      ingredients: [
        { key: 'caffeine', amount: 300, unit: 'mg' },
        { key: 'l-citrulline', amount: 4000, unit: 'mg' },
        { key: 'vitamin-b6', amount: 60, unit: 'mg' },
        { key: 'huperzine-a', amount: 200, unit: 'mcg' },
      ],
      doses: [dose('pre', '1 scoop', ['lift'])],
      reference: REFERENCE,
    }),
    item('quest', 'Quest protein (vanilla milkshake)', {
      shortNote: 'With banana slices',
      ingredients: [{ key: 'protein', amount: 24, unit: 'g' }],
      doses: [dose('pre', '1 scoop', ['lift'])],
    }),
    item('creatine', 'Creatine monohydrate', {
      shortNote: 'In broth',
      doses: [dose('pre', '', ['lift']), dose('all', '5 g')],
    }),
    item('malate', 'L-Citrulline malate', {
      ingredients: [{ key: 'l-citrulline', amount: 4.3, unit: 'g' }],
      doses: [dose('all', '6–7 g')],
    }),
    item('potassium', 'Potassium', {
      ingredients: [{ key: 'potassium', amount: 5400, unit: 'mg' }],
      doses: [dose('all', '5.4 g')],
    }),
    item('trans4orm', 'EVL Trans4orm', {
      ingredients: [
        { key: 'caffeine', amount: 87.5, unit: 'mg' },
        { key: 'vitamin-b6', amount: 1, unit: 'mg' },
      ],
      doses: [dose('am', '½ dose (1 capsule)')],
    }),
    item('fish-oil', 'Fish oil', { links: ['https://www.amazon.com/dp/B000'], doses: [dose('am', '1,000 mg')] }),
    item('glycine', 'Glycine', { keyCompound: 'Glycine', timing: 'With food', doses: [dose('am', '')] }),
    item('mag', 'Magnesium glycinate', { reference: { ...REFERENCE, typicalRange: '100–400 mg' }, doses: [dose('pm', '200 mg')] }),
    item('ashwagandha', 'Ashwagandha', {
      ingredients: [{ key: 'ashwagandha', amount: 300, unit: 'mg' }],
      doses: [dose('pm', '300–500 mg')],
    }),
    item('collagen', 'Hydrolyzed collagen peptides', {
      status: 'pending',
      keyCompound: 'Glycine · proline',
      timing: 'In the shake',
      ingredients: [{ key: 'protein', amount: 9, unit: 'g' }],
      doses: [dose('pre', '10–15 g', ['lift'])],
    }),
  ],
};
