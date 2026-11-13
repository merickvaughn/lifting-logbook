import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';

/**
 * Whether a file's `Program` cell names a non-cycle workout (proposal 2026-11-06, decision 23):
 * `non-cycle`, as export writes it, ignoring case and surrounding spaces. Such a row is stored
 * as a non-cycle workout, isn't a session for segmentation, and never changes a training max.
 */
export function isNonCycleProgram(program: string | null | undefined): boolean {
  return typeof program === 'string' && program.trim().toLowerCase() === NON_CYCLE_PROGRAM;
}

/**
 * Stamps an import row with the route's program, keeping a file's `non-cycle` program, which
 * names where the row belongs rather than which program the file is for.
 */
export function withImportProgram<T extends { program?: string | null }>(row: T, program: string): T & { program: string } {
  return { ...row, program: isNonCycleProgram(row.program) ? NON_CYCLE_PROGRAM : program };
}
