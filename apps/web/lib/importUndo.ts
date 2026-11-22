import type { ImportUndoResponse } from '@lifting-logbook/types';

/** An undo's outcome, worded as the import wizard words it: History and Settings show it (#1257, #1405). */
export function undoSummary(result: ImportUndoResponse): string {
  return (
    `Undo complete: ${result.restored} restored` +
    (result.skipped > 0 ? `, ${result.skipped} skipped` : '') +
    (result.flagged.length > 0 ? `, ${result.flagged.length} flagged (modified since import)` : '') +
    '.'
  );
}
