/**
 * Shared between ImportWizard.tsx's `commitErrors` list and
 * LiftRecordsImportForm.tsx's error list — both cap the rendered error list
 * to the same size (an uncapped list can run to thousands of `<li>` nodes for
 * a large all-or-nothing rejection). A single exported constant, not a bare
 * `20` literal duplicated in each file behind an unenforced "keep these in
 * sync" comment, so the two can never silently drift apart (#911 review,
 * eighth pass).
 */
export const MAX_RENDERED_IMPORT_ERRORS = 20;
