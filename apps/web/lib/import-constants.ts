/**
 * Shared by every place that renders a capped list of import-time messages —
 * ImportWizard.tsx's REVIEW-step `preview.errors` list, its PREVIEW/DONE-step
 * `commitErrors` list, and LiftRecordsImportForm.tsx's error list — so each
 * cap stays the same size without a bare `20` literal duplicated across files
 * behind an unenforced "keep these in sync" comment (#911 review, eighth
 * pass). Round 8 only converted two of those three sites; the third was
 * caught and fixed in round 9, by two independent review passes — see the
 * comment at ImportWizard.tsx's REVIEW-step error block for why that one
 * omission was lower-severity than the other two (the total count is shown
 * separately there, so the truncation itself was never silent).
 */
export const MAX_RENDERED_IMPORT_ERRORS = 20;

/**
 * Caps LiftRecordsImportForm.tsx's and ImportWizard.tsx's *skipped*-row lists
 * (duplicate records the import silently skipped, not validation errors) —
 * same rendering hazard as MAX_RENDERED_IMPORT_ERRORS (an uncapped list can
 * run to thousands of `<li>` nodes; being inside a collapsed `<details>` does
 * not defer React from creating them), but a semantically distinct count with
 * no invariant requiring it to match the errors cap, so it gets its own
 * constant rather than overloading MAX_RENDERED_IMPORT_ERRORS's name for an
 * unrelated list (#911 review, ninth pass).
 */
export const MAX_RENDERED_IMPORT_SKIPS = 20;
