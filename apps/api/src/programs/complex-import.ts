import {
  ComplexImportRow,
  ImportPreImage,
  NamedLift,
  complexImportKey,
  groupComplexImportRows,
  lookupLift,
  parseComplexes,
  validateComplexImport,
} from '@lifting-logbook/core';
import { BarbellComplex, ComplexComponent, ImportDelta, ImportPreview } from '@lifting-logbook/types';
import { complexComponentLift, isLiftName } from '../lifts/barbell-complex.util';
import { RepositoryBundle } from '../ports/factory';
import type { ImportHandler } from './import-handlers';

/** What the import does with one complex of the file. */
interface PlannedComplex {
  delta: ImportDelta;
  /** Set when the complex is created: its name and components as stored. */
  create?: { name: string; components: ComplexComponent[] };
}

function describe(components: readonly ComplexComponent[], customLifts: readonly NamedLift[]): string {
  return components
    .map(({ lift, reps }) => `${lookupLift(lift, customLifts).custom?.name ?? lift} × ${reps}`)
    .join(', ');
}

const sameComponents = (a: readonly ComplexComponent[], b: readonly ComplexComponent[]): boolean =>
  a.length === b.length && a.every((c, i) => c.lift === b[i]?.lift && c.reps === b[i]?.reps);

/** The components as stored on this account, and the lifts the account doesn't have. */
function resolveComponents(
  components: readonly ComplexComponent[],
  customLifts: readonly NamedLift[],
): { stored: ComplexComponent[]; unknown: string[] } {
  const stored: ComplexComponent[] = [];
  const unknown: string[] = [];
  for (const { lift, reps } of components) {
    const resolved = complexComponentLift(lift, customLifts);
    if (resolved === undefined) unknown.push(lift);
    else stored.push({ lift: resolved, reps });
  }
  return { stored, unknown: [...new Set(unknown)] };
}

/**
 * Each complex of the file against the account (#1514). A component's lift resolves to a catalog
 * lift or one of the account's custom lifts by name, as the complex editor resolves it. A complex
 * is skipped, saying why, when its name is a lift's or one of the account's complexes' (ignoring
 * case, #1506), or when a lift it names isn't on the account, so one complex can't fail the import.
 * A name taken by an identical complex is skipped silently: that file was imported already.
 */
async function planComplexes(rows: readonly ComplexImportRow[], repos: RepositoryBundle): Promise<PlannedComplex[]> {
  const [customLifts, stored] = await Promise.all([repos.customLift.list(), repos.barbellComplex.list()]);
  const byName = new Map<string, BarbellComplex>(stored.map((c) => [complexImportKey(c.name), c]));
  return groupComplexImportRows(rows).map(({ name, components }): PlannedComplex => {
    const key = complexImportKey(name);
    const { stored: resolved, unknown } = resolveComponents(components, customLifts);
    const after = describe(components, customLifts);
    const base = { key, label: name, after };
    const existing = byName.get(key);
    if (existing) {
      const before = describe(existing.components, customLifts);
      const identical = unknown.length === 0 && sameComponents(existing.components, resolved);
      return {
        delta: identical
          ? { ...base, kind: 'skip', before }
          : { ...base, kind: 'skip', before, message: `You already have a complex named "${existing.name}", which is kept as it is` },
      };
    }
    if (isLiftName(name, customLifts)) {
      return { delta: { ...base, kind: 'skip', message: `"${name}" is a lift's name on this account` } };
    }
    if (unknown.length > 0) {
      return {
        delta: {
          ...base,
          kind: 'skip',
          message: `This account has no lift named ${unknown.map((l) => `"${l}"`).join(', ')}. Add it as a custom lift, then import again`,
        },
      };
    }
    return { delta: { ...base, kind: 'create' }, create: { name, components: resolved } };
  });
}

/**
 * `complexes.csv` (#1514). Complexes belong to the lifter, so the program the import is made in
 * only files its batch for undo. A commit creates the complexes the preview shows as new and leaves
 * the rest; its pre-image keys each created complex by id, which undo deletes.
 */
export const complexesHandler: ImportHandler<ComplexImportRow> = {
  parse: parseComplexes,
  validate: validateComplexImport,
  async preview(valid, _program, repos): Promise<ImportPreview> {
    const deltas = (await planComplexes(valid, repos)).map((p) => p.delta);
    const count = (kind: ImportDelta['kind']) => deltas.filter((d) => d.kind === kind).length;
    return { creates: count('create'), updates: 0, skips: count('skip'), unresolved: 0, deltas };
  },
  async commit(valid, _program, repos) {
    const planned = await planComplexes(valid, repos);
    const preImage: ImportPreImage = {};
    for (const { create } of planned) {
      if (!create) continue;
      const complex = await repos.barbellComplex.create(create);
      preImage[complex.id] = { kind: 'created', wrote: { name: complex.name } };
    }
    const created = Object.keys(preImage).length;
    return { created, updated: 0, skipped: planned.length - created, preImage };
  },
};
