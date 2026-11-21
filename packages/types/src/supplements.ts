/**
 * Supplements (#1372): a stack of items, each dosed into slots on named day types.
 * Pure data shapes; the computation lives in packages/core/src/supplements.
 */

/** Slots tied to a workout; a dose in one must name at least one day type. */
export const WORKOUT_SLOTS = ['pre', 'intra', 'post'] as const;
/** Slots through the day (`all`) or at a time of day; no day types means every day. */
export const DAILY_SLOTS = ['all', 'am', 'noon', 'pm'] as const;
export const SUPPLEMENT_SLOTS = [...WORKOUT_SLOTS, ...DAILY_SLOTS] as const;

export type WorkoutSlot = (typeof WORKOUT_SLOTS)[number];
export type SupplementSlot = (typeof SUPPLEMENT_SLOTS)[number];

export const INGREDIENT_UNITS = ['mg', 'g', 'mcg'] as const;
export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

export type SupplementStatus = 'active' | 'pending';

export interface SupplementDayType {
  id: string;
  name: string;
  /** Session start, 24-hour `HH:MM`. Absent on a rest day. */
  sessionTime?: string;
}

/** Amount of one ingredient in a single serving. */
export interface Ingredient {
  key: string;
  amount: number;
  unit: IngredientUnit;
}

/** One component of a mix, kept so the mix's totals still include it. */
export interface SupplementPart {
  /** The item the part came from, so splitting the mix can bring it back. */
  itemId: string;
  name: string;
  ingredients: Ingredient[];
}

export interface SupplementDose {
  slot: SupplementSlot;
  /** Free text such as "1 scoop". Blank means the amount is not set. */
  amount: string;
  /** Servings taken per dose; multiplies the per-serving ingredients. */
  servings: number;
  /** Day types the dose applies on. */
  dayTypes: string[];
}

/** AIS Supplement Framework group A / B / C, as strong / moderate / limited. */
export const EVIDENCE_LEVELS = ['strong', 'moderate', 'limited'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/**
 * The read-only reference content of the catalog entry an item was created from (#1375). It is
 * copied onto the item when created, so a later catalog edit never changes a saved item.
 */
export interface SupplementReference {
  uses: string[];
  evidence: { level: EvidenceLevel; reason: string };
  cautions: string[];
  /** The usual daily range, as written, e.g. "3-5 g/day". */
  typicalRange: string;
  /**
   * The catalog's source keys. Only the key is kept, as for an advisory's `source`: a key never
   * changes, and `supplementSourceUrl` in `@lifting-logbook/core` gives its current https URL, so a
   * corrected URL reaches items already saved.
   */
  sources: string[];
}

export interface SupplementItem {
  id: string;
  name: string;
  keyCompound: string;
  timing: string;
  shortNote: string;
  longNote: string;
  status: SupplementStatus;
  /** Not yet confirmed against its label; shown but not counted. */
  unverified: boolean;
  links: string[];
  /** Per serving. */
  ingredients: Ingredient[];
  /** Present on a mix: its ingredients come from the parts instead of `ingredients`. */
  parts?: SupplementPart[];
  doses: SupplementDose[];
  /** The catalog entry the item was created from (#1375). Never changes after creation. */
  catalogKey?: string;
  /** Snapshot of that entry's reference content. Read-only: no change edits it. */
  reference?: SupplementReference;
}

/**
 * The fields an `edited` change may set. Status, doses, verification and parts each have
 * their own change, so an edit can't move, start, confirm or re-mix an item.
 */
export type SupplementItemDetails = Pick<
  SupplementItem,
  'name' | 'keyCompound' | 'timing' | 'shortNote' | 'longNote' | 'links' | 'ingredients'
>;

/**
 * Append-only history entry. `date` is `YYYY-MM-DD`; `seq` increases with every change
 * appended, and orders changes made on the same date.
 */
export type SupplementChange = { date: string; seq: number } & (
  | { type: 'added'; item: SupplementItem }
  | { type: 'edited'; itemId: string; changes: Partial<SupplementItemDetails> }
  | { type: 'moved'; itemId: string; doses: SupplementDose[] }
  | { type: 'started'; itemId: string }
  | { type: 'moved_to_pending'; itemId: string }
  /** `item` is the item as it stood when removed, so restoring it doesn't need a replay. */
  | { type: 'removed'; item: SupplementItem }
  | { type: 'restored'; itemId: string }
  | { type: 'confirmed'; itemId: string }
  | { type: 'mix_created'; mix: SupplementItem; partIds: string[] }
  | { type: 'folded_into_mix'; mixId: string; itemId: string }
  /** Brings a mix's parts back as separate items; the mix goes, or reverts to its own ingredients. */
  | { type: 'mix_split'; mixId: string }
  /** Replaces the day types (#1374). */
  | { type: 'day_types_set'; dayTypes: SupplementDayType[] }
  /** Sets the caffeine cutoff, 24-hour `HH:MM` (#1374). */
  | { type: 'caffeine_cutoff_set'; caffeineCutoff: string }
);

/**
 * Why replaying the change log skipped a change, or part of one: it named an item the log hasn't
 * added (`unknown-item`), an item folded into a mix (`folded-item`), an item that's removed
 * (`removed-item`), restored an item that isn't removed (`not-removed`), or split an item that
 * isn't a mix (`not-a-mix`).
 */
export type SupplementReplayAnomalyReason = 'unknown-item' | 'folded-item' | 'removed-item' | 'not-removed' | 'not-a-mix';

export const SUPPLEMENT_ADVISORY_RULES = [
  'lateStimulant',
  'highCaffeine',
  'highPotassium',
  'adaptogenAtNight',
  'missingAmount',
] as const;
export type SupplementAdvisoryRule = (typeof SUPPLEMENT_ADVISORY_RULES)[number];

/** Keys of the references the advisory rules cite. */
export const SUPPLEMENT_ADVISORY_SOURCES = [
  'fda-caffeine',
  'nih-ods-potassium',
  'adaptogen-timing',
  'stack-data',
] as const;
export type SupplementAdvisorySource = (typeof SUPPLEMENT_ADVISORY_SOURCES)[number];

export interface SupplementAdvisory {
  rule: SupplementAdvisoryRule;
  itemIds: string[];
  message: string;
  /** Key of the reference the rule cites. */
  source: SupplementAdvisorySource;
}

export type SupplementCatalogKind = 'compound' | 'product';

/** One match from `GET /supplements/catalog?q=`: what autofill fills in, plus the reference content (#1375). */
export interface SupplementCatalogEntry {
  /** Stable id, stored on an item as `catalogKey`. Never reused or renamed. */
  key: string;
  name: string;
  aliases: string[];
  kind: SupplementCatalogKind;
  keyCompound: string;
  /** Free text such as "5 g". */
  suggestedDose: string;
  timing: string;
  suggestedSlot: SupplementSlot;
  /** Per serving. */
  ingredients: Ingredient[];
  reference: SupplementReference;
}

/** The stored stack (#1374), returned by `GET /supplements` and by every write to it. */
export interface SupplementStackResponse {
  items: SupplementItem[];
  dayTypes: SupplementDayType[];
  /** 24-hour `HH:MM`. */
  caffeineCutoff: string;
}

/** What creating an item or a mix returns: the stack, and the new item's id. */
export interface SupplementCreatedResponse extends SupplementStackResponse {
  id: string;
}

/** A change, or part of one, that replay couldn't act on. */
export interface SupplementReplayAnomaly {
  seq: number;
  type: SupplementChange['type'];
  itemId: string;
  reason: SupplementReplayAnomalyReason;
}

/** `GET /supplements/as-of/:date`: the stack at the end of the date, replayed from the change log. */
export interface SupplementAsOfResponse {
  items: SupplementItem[];
  /** The date of the earliest change, or null with none: before it, the log has no record. */
  firstChangeDate: string | null;
  /** Changes replay skipped. Empty for a complete, well-ordered log. */
  anomalies: SupplementReplayAnomaly[];
}

/** The 409 code for a write that lost a race with another write to the stack (ADR-046). */
export const SUPPLEMENT_STALE_CODE = 'supplement-stale';
/** The 409 code for restoring an item that isn't removed, or is folded into a mix. */
export const SUPPLEMENT_NOT_REMOVED_CODE = 'supplement-not-removed';
