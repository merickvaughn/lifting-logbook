import type { ImportError } from '@lifting-logbook/types';

/**
 * True when an {@link ImportError} is about the lift/exercise name itself — either
 * missing entirely (`LIFT_EMPTY`) or present but not recognized (`UNRECOGNIZED_LIFT`)
 * — the two cases the Smart Import Wizard's interactive remap step can help resolve.
 *
 * Branches that need to react to this (e.g. LiftRecordsImportForm's Wizard-link CTA)
 * should check `code` here rather than comparing `err.field === IMPORT_ERROR_FIELD_LIFT`
 * directly: `field` is a free-form `string` with no compile-time guarantee a validator
 * still sets it, while `code` is a required, closed union — a renamed or removed code
 * fails to compile here instead of silently stopping the branch from ever matching. See #913.
 */
export function isLiftNameError(err: ImportError): boolean {
  return err.code === 'UNRECOGNIZED_LIFT' || err.code === 'LIFT_EMPTY';
}
