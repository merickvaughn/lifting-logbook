import type { AssignStretchStatus, ImportSuggestion, ImportSuggestionSessionChoice } from '@lifting-logbook/types';

/**
 * The closed value sets of a suggestion response (#1174), written once for the prompt, the JSON
 * Schema and the validator. Each is built from a `Record` over its type, so a value the type gains
 * or loses is a compile error here rather than a set that silently drifts.
 */
const valuesOf = <T extends string>(all: Record<T, true>) => Object.keys(all) as T[];

export const SUGGESTION_KINDS = valuesOf<ImportSuggestion['kind']>({ boundary: true, lone: true, status: true, program: true, note: true });
export const BOUNDARY_ACTIONS = valuesOf<Extract<ImportSuggestion, { kind: 'boundary' }>['action']>({ add: true, remove: true });
export const SESSION_CHOICES = valuesOf<ImportSuggestionSessionChoice>({ earlier: true, later: true, 'non-cycle': true, exclude: true });
export const STRETCH_STATUSES = valuesOf<AssignStretchStatus>({ 'in-progress': true, completed: true, overran: true, abandoned: true });
