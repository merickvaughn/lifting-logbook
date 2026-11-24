import { SUPPLEMENT_SUGGESTION_NAME_MAX } from '@lifting-logbook/types';
import { clip } from './suggestion-shape';

/**
 * What a supplement suggestion request may send (#1381), to the label database and to the AI.
 * Only the typed name goes, with control characters removed and length capped, and nothing else:
 * no stack, notes, user id or email. To the AI it travels as the single `untrustedName` field,
 * which the system prompt says is data, never instructions.
 */
export interface SupplementSuggestionPayload {
  untrustedName: string;
}

/** The typed name as it may leave the app; empty when nothing usable is left. */
export function sentName(typed: string): string {
  return clip(typed, SUPPLEMENT_SUGGESTION_NAME_MAX);
}

export function buildSupplementPayload(typed: string): SupplementSuggestionPayload {
  return { untrustedName: sentName(typed) };
}
