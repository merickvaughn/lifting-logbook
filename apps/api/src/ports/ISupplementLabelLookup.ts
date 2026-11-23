import type { SupplementSuggestion } from '@lifting-logbook/types';

/**
 * Tier 2 of the supplement suggestions (#1381): product labels found by name. Rejects when the
 * label database doesn't answer, which the service treats as an outage and falls through to tier 3.
 */
export interface ISupplementLabelLookup {
  lookup(name: string): Promise<SupplementSuggestion[]>;
}
