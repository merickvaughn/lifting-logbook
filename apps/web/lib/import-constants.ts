/**
 * Caps every rendered list of import-time errors — ImportWizard.tsx's
 * REVIEW-step `preview.errors` list and its PREVIEW-step `commitErrors`
 * list, and LiftRecordsImportForm.tsx's error list — to the same size, so
 * a bare `20` literal can't diverge across sites (#911 review, eighth
 * pass). Bounds the *render* only; the underlying response payload
 * (`errors`) is not capped server-side, so state/parse/transfer cost for a
 * large rejection is unbounded regardless of this constant (#911 review,
 * tenth pass — see #928 for the server-side follow-up).
 */
export const MAX_RENDERED_IMPORT_ERRORS = 20;

/**
 * Caps LiftRecordsImportForm.tsx's and ImportWizard.tsx's *skipped*-row
 * lists (duplicate records the import silently skipped, not validation
 * errors) — same rendering hazard as MAX_RENDERED_IMPORT_ERRORS, but a
 * semantically distinct count with no invariant requiring it to match the
 * errors cap (#911 review, ninth pass).
 */
export const MAX_RENDERED_IMPORT_SKIPS = 20;
