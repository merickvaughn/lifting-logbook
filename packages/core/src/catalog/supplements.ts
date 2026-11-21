import type { Ingredient, SupplementCatalogEntry, SupplementItem, SupplementReference } from '@lifting-logbook/types';

/*
 * The shared supplement catalog (#1375, suggestion tier 1 of #1372). It is a read-only reference
 * table the same for every user: the Registry / reference-data pattern (Fowler, Patterns of
 * Enterprise Application Architecture, Registry, https://martinfowler.com/eaaCatalog/registry.html).
 *
 * Autofill is a copy at creation time, not a live link (ADR-046 addendum): `itemFromCatalog`
 * writes the entry's values onto a new item, and nothing later reads the catalog back, so a
 * catalog edit never changes a saved item.
 *
 * Evidence levels follow the AIS Supplement Framework, https://www.ausport.gov.au/ais/nutrition/supplements:
 * group A (strong evidence for the use) is `strong`, group B (emerging evidence, or a use for
 * specific cases) is `moderate`, and group C (little or no evidence of benefit) is `limited`.
 * A substance in group D (not recommended: banned, or a high contamination risk), or in no group
 * at all, is `limited`, and its `reason` says which. Where an entry's evidence comes from an ISSN position stand or a NIH fact sheet instead, the
 * `reason` says which. Every dose range and caution cites only the sources in `SUPPLEMENT_SOURCES`:
 * NIH ODS, NCCIH, ISSN position stands, the AIS framework and peer-reviewed position stands.
 * Never retailer copy; a product's label facts may cite its manufacturer's product page.
 */

/**
 * Source key → https URL. A key is stable and is what an item's `reference` keeps; the URL may be
 * corrected here, and `supplementSourceUrl` gives the current one.
 */
export const SUPPLEMENT_SOURCES = {
  ais: 'https://www.ausport.gov.au/ais/nutrition/supplements',
  'issn-creatine': 'https://doi.org/10.1186/s12970-017-0173-z',
  'issn-caffeine': 'https://doi.org/10.1186/s12970-020-00383-4',
  'issn-beta-alanine': 'https://doi.org/10.1186/s12970-015-0090-y',
  'issn-protein': 'https://doi.org/10.1186/s12970-017-0177-8',
  'issn-review-2018': 'https://doi.org/10.1186/s12970-018-0242-y',
  'acsm-fluid': 'https://doi.org/10.1249/mss.0b013e31802fa199',
  'ods-omega3': 'https://ods.od.nih.gov/factsheets/Omega3FattyAcids-HealthProfessional/',
  'ods-calcium': 'https://ods.od.nih.gov/factsheets/Calcium-HealthProfessional/',
  'ods-potassium': 'https://ods.od.nih.gov/factsheets/Potassium-HealthProfessional/',
  'ods-magnesium': 'https://ods.od.nih.gov/factsheets/Magnesium-HealthProfessional/',
  'ods-multivitamin': 'https://ods.od.nih.gov/factsheets/MVMS-HealthProfessional/',
  'ods-iron': 'https://ods.od.nih.gov/factsheets/Iron-HealthProfessional/',
  'ods-iodine': 'https://ods.od.nih.gov/factsheets/Iodine-HealthProfessional/',
  'ods-zinc': 'https://ods.od.nih.gov/factsheets/Zinc-HealthProfessional/',
  'ods-selenium': 'https://ods.od.nih.gov/factsheets/Selenium-HealthProfessional/',
  'ods-vitamin-c': 'https://ods.od.nih.gov/factsheets/VitaminC-HealthProfessional/',
  'ods-ashwagandha': 'https://ods.od.nih.gov/factsheets/Ashwagandha-HealthProfessional/',
  'ods-carnitine': 'https://ods.od.nih.gov/factsheets/Carnitine-HealthProfessional/',
  'ods-probiotics': 'https://ods.od.nih.gov/factsheets/Probiotics-HealthProfessional/',
  'nccih-melatonin': 'https://www.nccih.nih.gov/health/melatonin-what-you-need-to-know',
  'nccih-turmeric': 'https://www.nccih.nih.gov/health/turmeric',
  'nccih-fenugreek': 'https://www.nccih.nih.gov/health/fenugreek',
  'label-nutricost-pre-x': 'https://nutricost.com/products/nutricost-pre-workout-complex-powder-30-servings',
  'label-evl-trans4orm': 'https://www.evlnutrition.com/products/trans4orm',
  'label-evl-pump-mode': 'https://www.evlnutrition.com/products/pumpmode-non-stimulant-pump-accelerator',
  'label-quest-protein': 'https://www.questnutrition.com/products/vanilla-milkshake-protein-powder',
} as const satisfies Readonly<Record<string, `https://${string}`>>;

export type SupplementSourceKey = keyof typeof SUPPLEMENT_SOURCES;

export function isSupplementSourceKey(key: string): key is SupplementSourceKey {
  return Object.prototype.hasOwnProperty.call(SUPPLEMENT_SOURCES, key);
}

/** The current URL of a source key from an item's `reference`, or undefined for a key the catalog no longer has. */
export function supplementSourceUrl(key: string): string | undefined {
  return isSupplementSourceKey(key) ? SUPPLEMENT_SOURCES[key] : undefined;
}

/** A catalog entry: what the API returns, with its reference content in place of `reference`. */
export type CatalogSupplement = Omit<SupplementCatalogEntry, 'reference'> &
  Omit<SupplementReference, 'sources'> & {
    /** Keys of `SUPPLEMENT_SOURCES`; at least one. */
    sources: SupplementSourceKey[];
  };

const mg = (key: string, amount: number): Ingredient => ({ key, amount, unit: 'mg' });
const g = (key: string, amount: number): Ingredient => ({ key, amount, unit: 'g' });
const mcg = (key: string, amount: number): Ingredient => ({ key, amount, unit: 'mcg' });

type Seed = Omit<CatalogSupplement, 'kind' | 'aliases'> & { aliases?: string[]; kind?: CatalogSupplement['kind'] };
const entry = (s: Seed): CatalogSupplement => ({ aliases: [], kind: 'compound', ...s });

const ASK = 'Check with a clinician before starting if you take medication, are pregnant or have a medical condition.';
const AIS_B = 'AIS Supplement Framework group B (emerging evidence).';
const AIS_UNLISTED = 'Not in any AIS Supplement Framework group, so it has no sports-evidence rating there.';

export const SUPPLEMENT_CATALOG: readonly CatalogSupplement[] = [
  entry({
    key: 'fish-oil', name: 'Fish oil (omega-3)', aliases: ['fish oil', 'omega-3', 'omega 3', 'epa dha'],
    keyCompound: 'EPA + DHA', suggestedDose: '1 g EPA + DHA', typicalRange: '250 mg to 3 g/day EPA + DHA',
    timing: 'With a meal that has fat', suggestedSlot: 'noon', ingredients: [mg('epa+dha', 1000)],
    uses: ['General cardiovascular and nutrition support', 'Some athletes use it for recovery'],
    evidence: { level: 'moderate', reason: `${AIS_B} NIH ODS covers intake and safety.` },
    cautions: ['High doses can thin the blood and may interact with anticoagulants.', ASK],
    sources: ['ods-omega3', 'ais'],
  }),
  entry({
    key: 'calcium', name: 'Calcium', keyCompound: 'Calcium', suggestedDose: '500 mg', typicalRange: 'Up to 1,000-1,200 mg/day from food and supplements',
    timing: 'With food, in doses of 500 mg or less', suggestedSlot: 'noon', ingredients: [mg('calcium', 500)],
    uses: ['Bone health when dietary intake falls short'],
    evidence: { level: 'strong', reason: 'NIH ODS: established nutrient with a defined requirement; benefit applies when intake is low.' },
    cautions: ['The adult upper limit is 2,000-2,500 mg/day from all sources.', 'Can reduce iron and zinc absorption if taken together.'],
    sources: ['ods-calcium'],
  }),
  entry({
    key: 'potassium', name: 'Potassium', keyCompound: 'Potassium', suggestedDose: '300 mg', typicalRange: 'Adequate intake 2,600-3,400 mg/day from food and supplements',
    timing: 'With food, spread through the day', suggestedSlot: 'all', ingredients: [mg('potassium', 300)],
    uses: ['Replacing potassium lost in sweat', 'Reaching the daily adequate intake'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; supplements are for shortfalls.' },
    cautions: ['High intakes are dangerous with kidney disease or with ACE inhibitors and some diuretics.', ASK],
    sources: ['ods-potassium'],
  }),
  entry({
    key: 'sodium', name: 'Sodium', aliases: ['salt', 'electrolytes'], keyCompound: 'Sodium', suggestedDose: '300 mg', typicalRange: 'Needs vary with sweat loss',
    timing: 'With fluid before or during long sessions', suggestedSlot: 'intra', ingredients: [mg('sodium', 300)],
    uses: ['Replacing sodium lost in sweat in long or hot sessions'],
    evidence: { level: 'moderate', reason: 'ACSM position stand on fluid replacement: sodium helps when sweat losses are large.' },
    cautions: ['Most diets already supply more sodium than needed; extra can raise blood pressure.', ASK],
    sources: ['acsm-fluid'],
  }),
  entry({
    key: 'magnesium', name: 'Magnesium', aliases: ['magnesium (generic)'], keyCompound: 'Magnesium', suggestedDose: '200 mg', typicalRange: 'Supplemental upper limit 350 mg/day',
    timing: 'With food or in the evening', suggestedSlot: 'pm', ingredients: [mg('magnesium', 200)],
    uses: ['Covering a dietary shortfall', 'Muscle and nerve function'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; benefit applies when intake is low.' },
    cautions: ['Doses above 350 mg/day from supplements can cause diarrhea.', 'Can interact with some antibiotics and bisphosphonates.'],
    sources: ['ods-magnesium'],
  }),
  entry({
    key: 'magnesium-glycinate', name: 'Magnesium glycinate', aliases: ['magnesium bisglycinate'], keyCompound: 'Magnesium', suggestedDose: '200 mg elemental', typicalRange: 'Supplemental upper limit 350 mg/day',
    timing: 'In the evening', suggestedSlot: 'pm', ingredients: [mg('magnesium', 200)],
    uses: ['Covering a dietary shortfall; usually gentler on the stomach'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; the glycinate form has no extra proven benefit.' },
    cautions: ['Doses above 350 mg/day from supplements can cause diarrhea.', 'Count elemental magnesium, not the compound weight.'],
    sources: ['ods-magnesium'],
  }),
  entry({
    key: 'magnesium-citrate', name: 'Magnesium citrate', keyCompound: 'Magnesium', suggestedDose: '200 mg elemental', typicalRange: 'Supplemental upper limit 350 mg/day',
    timing: 'With food', suggestedSlot: 'pm', ingredients: [mg('magnesium', 200)],
    uses: ['Covering a dietary shortfall'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; well absorbed.' },
    cautions: ['Has a laxative effect at higher doses.', 'Count elemental magnesium, not the compound weight.'],
    sources: ['ods-magnesium'],
  }),
  entry({
    key: 'multivitamin', name: 'Multivitamin', aliases: ['multivitamin/mineral', 'multi'], keyCompound: 'Multivitamin',
    suggestedDose: '1 serving', typicalRange: 'Per the label', timing: 'With a meal', suggestedSlot: 'am', ingredients: [],
    uses: ['Covering gaps in a restricted diet'],
    evidence: { level: 'moderate', reason: 'NIH ODS: helps with shortfalls; no clear benefit for a varied diet.' },
    cautions: ['Check the label so nutrients you also take separately do not add up past their upper limits.'],
    sources: ['ods-multivitamin'],
  }),
  entry({
    key: 'whey-protein', name: 'Protein powder (whey)', aliases: ['whey protein', 'whey', 'protein powder'], keyCompound: 'Protein',
    suggestedDose: '1 scoop', typicalRange: '1.4-2.0 g/kg/day protein in total', timing: 'After training, or whenever protein falls short', suggestedSlot: 'post', ingredients: [g('protein', 25)],
    uses: ['Reaching a daily protein target', 'Building and keeping muscle with resistance training'],
    evidence: { level: 'strong', reason: 'ISSN position stand on protein and exercise.' },
    cautions: ['Scoop size and protein per scoop differ between brands; set the amount from the label.', 'Milk allergy and lactose intolerance.'],
    sources: ['issn-protein', 'ais'],
  }),
  entry({
    key: 'iron', name: 'Iron', keyCompound: 'Iron', suggestedDose: 'Per a clinician', typicalRange: 'Upper limit 45 mg/day',
    timing: 'Away from calcium, with vitamin C', suggestedSlot: 'am', ingredients: [],
    uses: ['Correcting a diagnosed deficiency'],
    evidence: { level: 'strong', reason: 'NIH ODS: effective for deficiency; no benefit without one.' },
    cautions: ['Take only for a deficiency a blood test has shown; excess iron is harmful.', 'Keep out of reach of children: overdose is dangerous.'],
    sources: ['ods-iron', 'ais'],
  }),
  entry({
    key: 'iodine', name: 'Iodine', keyCompound: 'Iodine', suggestedDose: '150 mcg', typicalRange: 'RDA 150 mcg/day; upper limit 1,100 mcg/day',
    timing: 'With food', suggestedSlot: 'am', ingredients: [mcg('iodine', 150)],
    uses: ['Thyroid function when intake is low'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; supplements matter when intake is low.' },
    cautions: ['Too much or too little can affect the thyroid.', ASK],
    sources: ['ods-iodine'],
  }),
  entry({
    key: 'zinc', name: 'Zinc', keyCompound: 'Zinc', suggestedDose: '15 mg', typicalRange: 'RDA 8-11 mg/day; upper limit 40 mg/day',
    timing: 'With food, away from calcium and iron', suggestedSlot: 'pm', ingredients: [mg('zinc', 15)],
    uses: ['Covering a dietary shortfall', 'Immune function'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; benefit applies when intake is low.' },
    cautions: ['Long-term intake above 40 mg/day can lower copper.', 'Can cause nausea on an empty stomach.'],
    sources: ['ods-zinc'],
  }),
  entry({
    key: 'selenium', name: 'Selenium', keyCompound: 'Selenium', suggestedDose: '55 mcg', typicalRange: 'RDA 55 mcg/day; upper limit 400 mcg/day',
    timing: 'With food', suggestedSlot: 'am', ingredients: [mcg('selenium', 55)],
    uses: ['Covering a dietary shortfall'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; no proven benefit above the RDA.' },
    cautions: ['Above 400 mcg/day risks toxicity.', 'Many multivitamins already contain it.'],
    sources: ['ods-selenium'],
  }),
  entry({
    key: 'ashwagandha', name: 'Ashwagandha', aliases: ['withania somnifera'], keyCompound: 'Ashwagandha', suggestedDose: '300 mg extract', typicalRange: 'Studies used 250-600 mg/day of extract',
    timing: 'Morning or midday', suggestedSlot: 'am', ingredients: [mg('ashwagandha', 300)],
    uses: ['Stress and sleep support', 'Some athletes use it for recovery'],
    evidence: { level: 'limited', reason: 'NIH ODS: small short trials; long-term safety unknown.' },
    cautions: ['Usually taken earlier in the day; at night it may disturb sleep.', 'Avoid in pregnancy; reports of liver injury and thyroid effects.', ASK],
    sources: ['ods-ashwagandha'],
  }),
  entry({
    key: 'melatonin', name: 'Melatonin', keyCompound: 'Melatonin', suggestedDose: '0.5 mg', typicalRange: 'Studies used 0.5-5 mg',
    timing: '1-2 hours before bed', suggestedSlot: 'pm', ingredients: [mg('melatonin', 0.5)],
    uses: ['Jet lag', 'Shifting sleep time'],
    evidence: { level: 'moderate', reason: 'NCCIH: short-term use helps jet lag and delayed sleep; less for general insomnia.' },
    cautions: ['Label amounts often differ from what is inside.', 'May cause drowsiness the next day.', ASK],
    sources: ['nccih-melatonin'],
  }),
  entry({
    key: 'apple-cider-vinegar', name: 'Apple cider vinegar', aliases: ['acv'], keyCompound: 'Acetic acid', suggestedDose: '15 mL diluted', typicalRange: '15-30 mL/day diluted',
    timing: 'Diluted, before a meal', suggestedSlot: 'noon', ingredients: [],
    uses: ['Used for blood sugar and appetite'],
    evidence: { level: 'limited', reason: `${AIS_UNLISTED} No NIH fact sheet.` },
    cautions: ['Undiluted vinegar can damage tooth enamel and the throat.'],
    sources: ['ais'],
  }),
  entry({
    key: 'anthocyanins', name: 'Anthocyanins (blueberry extract)', aliases: ['blueberry extract', 'anthocyanin'], keyCompound: 'Anthocyanins', suggestedDose: 'Per the label', typicalRange: 'Studies used roughly 300-600 mg/day',
    timing: 'With food', suggestedSlot: 'am', ingredients: [],
    uses: ['Used for exercise recovery and antioxidant support'],
    evidence: { level: 'moderate', reason: `${AIS_B} The framework lists fruit-derived polyphenols, from berries among others.` },
    cautions: ['Extract strength varies by product; set the amount from the label.'],
    sources: ['ais'],
  }),
  entry({
    key: 'curcumin-piperine', name: 'Curcumin with piperine', aliases: ['curcumin', 'turmeric'], keyCompound: 'Curcumin', suggestedDose: '500 mg curcumin', typicalRange: 'Studies used 500-2,000 mg/day',
    timing: 'With a meal', suggestedSlot: 'noon', ingredients: [mg('curcumin', 500)],
    uses: ['Used for joint soreness and inflammation'],
    evidence: { level: 'limited', reason: 'NCCIH: evidence is weak or mixed; absorption is poor without piperine.' },
    cautions: ['Piperine raises the blood levels of many drugs.', 'High doses have been linked to liver injury.', ASK],
    sources: ['nccih-turmeric', 'ais'],
  }),
  entry({
    key: 'maca', name: 'Maca', keyCompound: 'Maca', suggestedDose: '1.5 g', typicalRange: 'Studies used 1.5-3 g/day',
    timing: 'Morning or midday', suggestedSlot: 'am', ingredients: [g('maca', 1.5)],
    uses: ['Used for energy and libido'],
    evidence: { level: 'limited', reason: 'AIS Supplement Framework group D: not recommended, because maca products are often mixed with banned ingredients.' },
    cautions: ['Tested athletes: maca products carry a risk of banned ingredients, which is why the AIS lists maca in group D.', 'Usually taken earlier in the day; at night it may disturb sleep.', ASK],
    sources: ['ais'],
  }),
  entry({
    key: 'fenugreek', name: 'Fenugreek', keyCompound: 'Fenugreek', suggestedDose: 'Per the label', typicalRange: 'Studies used roughly 500-1,000 mg/day of extract',
    timing: 'With a meal', suggestedSlot: 'noon', ingredients: [],
    uses: ['Used for testosterone and blood sugar'],
    evidence: { level: 'limited', reason: 'NCCIH: little reliable evidence for these uses.' },
    cautions: ['Can cause stomach upset and a maple-syrup odor.', 'Can lower blood sugar; avoid in pregnancy.', ASK],
    sources: ['nccih-fenugreek'],
  }),
  entry({
    key: 'cocoa-flavanols', name: 'Cocoa flavanols', aliases: ['cocoa extract', 'flavanols'], keyCompound: 'Cocoa flavanols', suggestedDose: 'Per the label', typicalRange: 'Studies used roughly 400-900 mg/day flavanols',
    timing: 'With food', suggestedSlot: 'am', ingredients: [],
    uses: ['Used for blood flow and exercise recovery'],
    evidence: { level: 'limited', reason: `${AIS_UNLISTED}` },
    cautions: ['Cocoa products can contain caffeine and heavy metals.'],
    sources: ['ais'],
  }),
  entry({
    key: 'creatine-monohydrate', name: 'Creatine monohydrate', aliases: ['creatine'], keyCompound: 'Creatine', suggestedDose: '5 g', typicalRange: '3-5 g/day',
    timing: 'Any time; consistency matters more than timing', suggestedSlot: 'all', ingredients: [g('creatine', 5)],
    uses: ['More strength and lean mass with resistance training', 'More power in repeated short efforts'],
    evidence: { level: 'strong', reason: 'ISSN position stand: the most effective supplement for high-intensity capacity and lean mass.' },
    cautions: ['Can raise body weight by 1-2 kg through water in muscle.', 'Take with fluid; check with a clinician if you have kidney disease.'],
    sources: ['issn-creatine', 'ais'],
  }),
  entry({
    key: 'citrulline-malate', name: 'L-citrulline malate', aliases: ['citrulline', 'l-citrulline', 'citrulline malate'], keyCompound: 'Citrulline', suggestedDose: '6 g citrulline malate', typicalRange: 'Studies used 6-8 g/day',
    timing: '30-60 minutes before training', suggestedSlot: 'pre', ingredients: [g('citrulline malate', 6)],
    uses: ['Used for muscular endurance and pump'],
    evidence: { level: 'limited', reason: 'ISSN 2018 review of sport nutrition: mixed results for performance.' },
    cautions: ['Citrulline malate is about half citrulline by weight; label amounts differ.', 'Can cause stomach upset.'],
    sources: ['issn-review-2018'],
  }),
  entry({
    key: 'agmatine-sulfate', name: 'Agmatine sulfate', aliases: ['agmatine'], keyCompound: 'Agmatine', suggestedDose: '1 g', typicalRange: 'Commonly 1-2 g/day',
    timing: 'Before training', suggestedSlot: 'pre', ingredients: [g('agmatine sulfate', 1)],
    uses: ['Used for pump and training focus'],
    evidence: { level: 'limited', reason: `${AIS_UNLISTED} Few human trials on performance.` },
    cautions: ['Little human safety data; avoid in pregnancy.', ASK],
    sources: ['ais'],
  }),
  entry({
    key: 'beta-alanine', name: 'Beta-alanine', keyCompound: 'Beta-alanine', suggestedDose: '3.2 g', typicalRange: '4-6 g/day for at least 2-4 weeks, split into doses of 2 g or less',
    timing: 'Split through the day; the effect builds over weeks', suggestedSlot: 'all', ingredients: [g('beta-alanine', 3.2)],
    uses: ['Better performance in efforts of 1-4 minutes'],
    evidence: { level: 'strong', reason: 'ISSN position stand: improves high-intensity exercise of 1-4 minutes.' },
    cautions: ['Causes harmless tingling (paresthesia) at larger single doses.'],
    sources: ['issn-beta-alanine', 'ais'],
  }),
  entry({
    key: 'acetyl-l-carnitine', name: 'Acetyl-L-carnitine', aliases: ['alcar', 'acetyl l carnitine'], keyCompound: 'Acetyl-L-carnitine', suggestedDose: '500 mg', typicalRange: 'Studies used 500-2,000 mg/day',
    timing: 'With food', suggestedSlot: 'am', ingredients: [mg('acetyl-l-carnitine', 500)],
    uses: ['Used for energy and recovery'],
    evidence: { level: 'limited', reason: 'NIH ODS: little evidence for performance in healthy people.' },
    cautions: ['Can cause nausea and a fishy body odor.', ASK],
    sources: ['ods-carnitine'],
  }),
  entry({
    key: 'l-carnitine-l-tartrate', name: 'L-carnitine L-tartrate', aliases: ['lclt', 'l-carnitine', 'carnitine'], keyCompound: 'L-carnitine', suggestedDose: '2 g', typicalRange: 'Studies used 1-3 g/day',
    timing: 'With food', suggestedSlot: 'post', ingredients: [g('l-carnitine l-tartrate', 2)],
    uses: ['Used for recovery after hard training'],
    evidence: { level: 'limited', reason: 'NIH ODS: little evidence for performance in healthy people.' },
    cautions: ['Can cause nausea and a fishy body odor.', ASK],
    sources: ['ods-carnitine'],
  }),
  entry({
    key: 'taurine', name: 'Taurine', keyCompound: 'Taurine', suggestedDose: '1 g', typicalRange: 'Studies used 1-3 g/day',
    timing: 'Before training', suggestedSlot: 'pre', ingredients: [g('taurine', 1)],
    uses: ['Used for endurance and recovery'],
    evidence: { level: 'limited', reason: `${AIS_UNLISTED}` },
    cautions: ['Often combined with caffeine in energy products; count that caffeine too.'],
    sources: ['ais'],
  }),
  entry({
    key: 'coq10', name: 'CoQ10', aliases: ['coenzyme q10', 'ubiquinone', 'ubiquinol'], keyCompound: 'Coenzyme Q10', suggestedDose: '100 mg', typicalRange: 'Studies used 100-300 mg/day',
    timing: 'With a meal that has fat', suggestedSlot: 'am', ingredients: [mg('coq10', 100)],
    uses: ['Used for energy and statin-related muscle symptoms'],
    evidence: { level: 'limited', reason: `${AIS_UNLISTED}` },
    cautions: ['May interact with warfarin and blood pressure drugs.', ASK],
    sources: ['ais'],
  }),
  entry({
    key: 'l-theanine', name: 'L-theanine', aliases: ['theanine'], keyCompound: 'L-theanine', suggestedDose: '200 mg', typicalRange: 'Studies used 100-400 mg/day',
    timing: 'With caffeine, or in the evening', suggestedSlot: 'pre', ingredients: [mg('l-theanine', 200)],
    uses: ['Calm focus, often with caffeine'],
    evidence: { level: 'limited', reason: `${AIS_UNLISTED}` },
    cautions: ['May lower blood pressure.'],
    sources: ['ais'],
  }),
  entry({
    key: 'collagen-peptides', name: 'Collagen peptides', aliases: ['collagen'], keyCompound: 'Collagen', suggestedDose: '10 g', typicalRange: 'Studies used 5-15 g/day',
    timing: 'With vitamin C, before tendon-loading work', suggestedSlot: 'pre', ingredients: [g('collagen', 10)],
    uses: ['Used for tendon and joint support'],
    evidence: { level: 'moderate', reason: AIS_B },
    cautions: ['Incomplete protein: do not count it as a full protein source.', 'Animal-derived.'],
    sources: ['ais', 'issn-review-2018'],
  }),
  entry({
    key: 'probiotic', name: 'Probiotic', aliases: ['probiotics'], keyCompound: 'Probiotic', suggestedDose: 'Per the label', typicalRange: 'Strain and dose specific',
    timing: 'As the label says', suggestedSlot: 'am', ingredients: [],
    uses: ['Gut health; fewer upper-respiratory illnesses in some athletes'],
    evidence: { level: 'moderate', reason: `${AIS_B} NIH ODS: effects depend on the strain.` },
    cautions: ['Effects are strain specific.', 'Can cause infection in people with weakened immunity.'],
    sources: ['ods-probiotics', 'ais'],
  }),
  entry({
    key: 'vitamin-c', name: 'Vitamin C', aliases: ['ascorbic acid'], keyCompound: 'Vitamin C', suggestedDose: '500 mg', typicalRange: 'RDA 75-90 mg/day; upper limit 2,000 mg/day',
    timing: 'With food', suggestedSlot: 'am', ingredients: [mg('vitamin c', 500)],
    uses: ['Covering a dietary shortfall', 'Helps absorb iron'],
    evidence: { level: 'moderate', reason: 'NIH ODS: established nutrient; no proven performance benefit.' },
    cautions: ['Above 2,000 mg/day causes diarrhea.', 'Large doses around training may blunt some training adaptations.'],
    sources: ['ods-vitamin-c', 'ais'],
  }),
  entry({
    key: 'polypodium-leucotomos', name: 'Polypodium leucotomos', aliases: ['polypodium', 'fernblock'], keyCompound: 'Polypodium leucotomos extract', suggestedDose: '240 mg', typicalRange: 'Studies used 240-480 mg/day',
    timing: 'Morning, before sun exposure', suggestedSlot: 'am', ingredients: [mg('polypodium leucotomos', 240)],
    uses: ['Used for sun-sensitivity support'],
    evidence: { level: 'limited', reason: `${AIS_UNLISTED} Not a sports supplement.` },
    cautions: ['It does not replace sunscreen.', ASK],
    sources: ['ais'],
  }),
  entry({
    key: 'dietary-nitrate', name: 'Dietary nitrate', aliases: ['nitrate', 'beetroot juice', 'beet juice'], keyCompound: 'Nitrate', suggestedDose: '400-800 mg nitrate', typicalRange: '5-9 mmol (310-560 mg) nitrate',
    timing: '2-3 hours before training', suggestedSlot: 'pre', ingredients: [mg('nitrate', 400)],
    uses: ['Better endurance performance and efficiency'],
    evidence: { level: 'strong', reason: 'AIS Supplement Framework group A.' },
    cautions: ['Can turn urine and stool red (beetroot).', 'May lower blood pressure.', 'Mouthwash can reduce the effect.'],
    sources: ['ais', 'issn-review-2018'],
  }),
  entry({
    key: 'caffeine', name: 'Caffeine', keyCompound: 'Caffeine', suggestedDose: '3-6 mg/kg', typicalRange: '3-6 mg/kg; at most 400 mg/day',
    timing: '30-60 minutes before training', suggestedSlot: 'pre', ingredients: [mg('caffeine', 200)],
    uses: ['Better endurance, strength and alertness'],
    evidence: { level: 'strong', reason: 'ISSN position stand on caffeine and exercise.' },
    cautions: ['Late doses can disturb sleep.', 'Above about 400 mg/day, anxiety, jitters and a fast heart rate are more likely.', 'Count caffeine from every product in the stack.'],
    sources: ['issn-caffeine', 'ais'],
  }),
  entry({
    key: 'nutricost-pre-x', name: 'Nutricost Pre-X', aliases: ['pre-x'], kind: 'product', keyCompound: 'Caffeine', suggestedDose: '1 serving', typicalRange: 'Per the label',
    timing: '30 minutes before training', suggestedSlot: 'pre', ingredients: [mg('caffeine', 300)],
    uses: ['Pre-workout energy and focus'],
    evidence: { level: 'strong', reason: 'The caffeine is supported by the ISSN position stand; the rest of the formula is not rated here.' },
    cautions: ['300 mg of caffeine per serving is most of a day’s 400 mg; avoid it late in the day.', 'Only the caffeine amount is filled in; read the rest from your label.'],
    sources: ['label-nutricost-pre-x', 'issn-caffeine'],
  }),
  entry({
    key: 'evl-trans4orm', name: 'EVL Trans4orm', aliases: ['trans4orm', 'evlution trans4orm'], kind: 'product', keyCompound: 'Caffeine', suggestedDose: '1 serving', typicalRange: 'Per the label',
    timing: '30 minutes before training', suggestedSlot: 'pre', ingredients: [mg('caffeine', 175)],
    uses: ['Pre-workout energy and focus'],
    evidence: { level: 'strong', reason: 'The caffeine is supported by the ISSN position stand; the rest of the formula is not rated here.' },
    cautions: ['Avoid it late in the day.', 'Only the caffeine amount is filled in; read the rest from your label.'],
    sources: ['label-evl-trans4orm', 'issn-caffeine'],
  }),
  entry({
    key: 'evl-pump-mode', name: 'EVL Pump Mode', aliases: ['pump mode', 'evlution pump mode'], kind: 'product', keyCompound: 'Stimulant-free pump formula', suggestedDose: '1 serving', typicalRange: 'Per the label',
    timing: '30 minutes before training', suggestedSlot: 'pre', ingredients: [],
    uses: ['Stimulant-free pre-workout'],
    evidence: { level: 'limited', reason: 'The AIS Supplement Framework rates ingredients, not this product, and its ingredients are not rated here.' },
    cautions: ['Stimulant-free: no caffeine counts toward your daily total.', 'Ingredient amounts are not filled in; read them from your label.'],
    sources: ['label-evl-pump-mode', 'ais'],
  }),
  entry({
    key: 'quest-protein-powder', name: 'Quest protein powder', aliases: ['quest protein'], kind: 'product', keyCompound: 'Protein', suggestedDose: '1 scoop', typicalRange: 'Per the label',
    timing: 'After training, or whenever protein falls short', suggestedSlot: 'post', ingredients: [g('protein', 24)],
    uses: ['Reaching a daily protein target'],
    evidence: { level: 'strong', reason: 'ISSN position stand on protein and exercise.' },
    cautions: ['Only the protein amount is filled in; read the rest from your label.', 'Milk allergy and lactose intolerance.'],
    sources: ['label-quest-protein', 'issn-protein'],
  }),
];

const norm = (s: string) => s.trim().toLowerCase();

/** The entry with this key, or undefined. */
export function supplementByKey(key: string): CatalogSupplement | undefined {
  return SUPPLEMENT_CATALOG.find((e) => e.key === key);
}

/** The entry whose name or alias is `name`, ignoring case and outer spaces. */
export function findSupplement(name: string): CatalogSupplement | undefined {
  const n = norm(name);
  if (n === '') return undefined;
  return SUPPLEMENT_CATALOG.find((e) => norm(e.name) === n || e.aliases.some((a) => norm(a) === n));
}

/** Entries whose name or an alias contains `q`, ignoring case; names starting with it first. Blank gives none. */
export function searchSupplements(q: string): CatalogSupplement[] {
  const n = norm(q);
  if (n === '') return [];
  const names = (e: CatalogSupplement) => [e.name, ...e.aliases].map(norm);
  const hits = SUPPLEMENT_CATALOG.filter((e) => names(e).some((x) => x.includes(n)));
  const starts = (e: CatalogSupplement) => names(e).some((x) => x.startsWith(n));
  return [...hits.filter(starts), ...hits.filter((e) => !starts(e))];
}

/** The entry's read-only reference content. */
export function catalogReference(e: CatalogSupplement): SupplementReference {
  return {
    uses: [...e.uses],
    evidence: { ...e.evidence },
    cautions: [...e.cautions],
    typicalRange: e.typicalRange,
    sources: [...e.sources],
  };
}

/** What `GET /supplements/catalog` returns for an entry. */
export function toCatalogEntry(e: CatalogSupplement): SupplementCatalogEntry {
  return {
    key: e.key,
    name: e.name,
    aliases: [...e.aliases],
    kind: e.kind,
    keyCompound: e.keyCompound,
    suggestedDose: e.suggestedDose,
    timing: e.timing,
    suggestedSlot: e.suggestedSlot,
    ingredients: e.ingredients.map((i) => ({ ...i })),
    reference: catalogReference(e),
  };
}

/** The fields of a new item the lifter may have typed, which autofill must not overwrite. */
export type TypedItemFields = Partial<
  Pick<SupplementItem, 'name' | 'keyCompound' | 'timing' | 'shortNote' | 'longNote' | 'ingredients' | 'links'>
>;

/**
 * The detail fields and reference of a new item created from `e` (ADR-046 addendum). A field the
 * lifter typed (a non-blank string, a non-empty list) is kept; a blank or absent one takes the
 * entry's value. `catalogKey` and `reference` are always the entry's, and are a copy: later
 * edits to the catalog or to the returned item don't reach each other.
 */
export function itemFromCatalog(
  e: CatalogSupplement,
  typed: TypedItemFields = {},
): Pick<SupplementItem, 'name' | 'keyCompound' | 'timing' | 'shortNote' | 'longNote' | 'links' | 'ingredients' | 'catalogKey' | 'reference'> {
  const text = (value: string | undefined, fallback: string) => (value !== undefined && value.trim() !== '' ? value : fallback);
  const list = <T>(value: T[] | undefined, fallback: T[]) => (value !== undefined && value.length > 0 ? value : fallback);
  return {
    name: text(typed.name, e.name),
    keyCompound: text(typed.keyCompound, e.keyCompound),
    timing: text(typed.timing, e.timing),
    shortNote: text(typed.shortNote, ''),
    longNote: text(typed.longNote, ''),
    links: typed.links ?? [],
    ingredients: list(typed.ingredients, e.ingredients.map((i) => ({ ...i }))),
    catalogKey: e.key,
    reference: catalogReference(e),
  };
}
