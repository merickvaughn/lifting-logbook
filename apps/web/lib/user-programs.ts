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

export function isCustomProgramId(id: string): boolean {
  return UUID_PATTERN.test(id);
}

/**
 * The user's custom programs, plus the template they're on if they're on one, with the
 * active program first: what the importer can write to (#1115) and History can show (#1300).
 * With `recorded`, the programs holding their sets, it adds each template among them too, so a
 * template they imported into but can't pick on the Programs page can still be viewed (#1454).
 *
 * The template's name falls back to its slug because the catalog doesn't list every
 * slug the API serves ('5-3-1' is a preset, while the catalog's entry is '531').
 *
 * A recorded UUID that isn't among `customPrograms` is a custom program that was deleted: deleting
 * one leaves its sets stored under its id, so it's listed under a name that says so (#1465). A
 * caller that couldn't read the custom programs must leave their ids out of `recorded`.
 */
export function userPrograms(
  customPrograms: CustomProgramSummaryResponse[],
  activeProgram: string | null,
  recorded: readonly string[] = [],
): UserProgram[] {
  const programs: UserProgram[] = [...customPrograms];
  const templates = new Set([activeProgram ?? '', ...recorded]);
  const customIds = new Set(customPrograms.map((p) => p.id));
  for (const id of templates) {
    if (!id || customIds.has(id)) continue;
    if (isCustomProgramId(id)) {
      if (recorded.includes(id)) programs.push({ id, name: `Deleted program (${id.slice(0, 8)})` });
      continue;
    }
    const name = PROGRAMS.find((p) => p.id === id)?.name ?? id;
    programs.push({ id, name, isTemplate: true });
  }
  return programs.sort((a, b) => Number(b.id === activeProgram) - Number(a.id === activeProgram));
}
