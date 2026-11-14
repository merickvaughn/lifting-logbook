import type { CustomProgramSummaryResponse } from '@lifting-logbook/types';
import { PROGRAMS } from './programs';

export type UserProgram = {
  id: string;
  name: string;
  /** A built-in template rather than a custom program. Its spec can't be written to. */
  isTemplate?: boolean;
};

// Custom programs are addressed by UUID and built-in templates by slug, as on the API.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user's custom programs, plus the template they're on if they're on one, with the
 * active program first: what the importer can write to (#1115) and History can show (#1300).
 *
 * The template's name falls back to its slug because the catalog doesn't list every
 * slug the API serves ('5-3-1' is a preset, while the catalog's entry is '531').
 */
export function userPrograms(
  customPrograms: CustomProgramSummaryResponse[],
  activeProgram: string | null,
): UserProgram[] {
  const programs: UserProgram[] = [...customPrograms];
  if (activeProgram && !UUID_PATTERN.test(activeProgram)) {
    const name = PROGRAMS.find((p) => p.id === activeProgram)?.name ?? activeProgram;
    programs.push({ id: activeProgram, name, isTemplate: true });
  }
  return programs.sort((a, b) => Number(b.id === activeProgram) - Number(a.id === activeProgram));
}
