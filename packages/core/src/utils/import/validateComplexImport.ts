import { COMPLEX_LIMITS, ComplexComponent, ImportError, IMPORT_ERROR_FIELD_LIFT } from '@lifting-logbook/types';
import { ComplexImportRow } from '../parser/parseComplexes';

/** A complex as a `complexes.csv` file defines it: its name and its components in order. */
export interface ImportedComplex {
  name: string;
  components: ComplexComponent[];
}

/**
 * A complex's identity in an import: its name, ignoring case, as the API's name check does
 * (#1506). It is the preview delta's `key`, and so what `excludeKeys` names.
 */
export function complexImportKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Validates `complexes.csv` rows (#1514), collecting every error. Row numbers are 1-based and
 * exclude the header. A row needs a name within `COMPLEX_LIMITS.MAX_NAME_LENGTH`, a whole
 * `Component` of 1 or more, a lift, and whole reps from 1 to `COMPLEX_LIMITS.MAX_REPS`. Rows are
 * grouped by name, ignoring case, and a complex needs `MIN_COMPONENTS` to `MAX_COMPONENTS`
 * components, each position once. Every row of a complex that fails is an error, so no half of
 * one is kept.
 *
 * Whether each lift exists, and whether the account already uses the name, depend on the account,
 * so the API's preview reports those instead.
 */
export function validateComplexImport(rows: ComplexImportRow[]): {
  valid: ComplexImportRow[];
  errors: ImportError[];
} {
  const errors: ImportError[] = [];
  const rowOk = rows.map((r, i) => {
    const row = i + 1;
    const before = errors.length;
    if (!r.complex) {
      errors.push({ row, field: 'complex', code: 'COMPLEX_NAME_INVALID', message: 'Complex is empty' });
    } else if (r.complex.length > COMPLEX_LIMITS.MAX_NAME_LENGTH) {
      errors.push({
        row,
        field: 'complex',
        code: 'COMPLEX_NAME_INVALID',
        message: `Complex is longer than ${COMPLEX_LIMITS.MAX_NAME_LENGTH} characters`,
      });
    }
    if (!Number.isInteger(r.component) || r.component < 1) {
      errors.push({ row, field: 'component', code: 'COMPONENT_INVALID', message: 'Component must be a whole number from 1' });
    }
    if (!r.lift) errors.push({ row, field: IMPORT_ERROR_FIELD_LIFT, code: 'LIFT_EMPTY', message: 'lift is empty' });
    if (!Number.isInteger(r.reps) || r.reps < 1 || r.reps > COMPLEX_LIMITS.MAX_REPS) {
      errors.push({
        row,
        field: 'reps',
        code: 'REPS_INVALID',
        message: `Reps must be a whole number from 1 to ${COMPLEX_LIMITS.MAX_REPS}`,
      });
    }
    return errors.length === before;
  });

  // Each complex's name as first spelled, its first row, and its rows with their 1-based numbers.
  const groups = new Map<
    string,
    { name: string; first: number; rows: { row: number; component: number; ok: boolean }[] }
  >();
  rows.forEach((r, i) => {
    if (!r.complex) return;
    const key = complexImportKey(r.complex);
    const group = groups.get(key) ?? { name: r.complex, first: i + 1, rows: [] };
    group.rows.push({ row: i + 1, component: r.component, ok: rowOk[i] === true });
    groups.set(key, group);
  });
  const badGroup = new Set<string>();
  for (const [key, { name, first, rows: members }] of groups) {
    if (members.length < COMPLEX_LIMITS.MIN_COMPONENTS || members.length > COMPLEX_LIMITS.MAX_COMPONENTS) {
      badGroup.add(key);
      errors.push({
        row: first,
        field: 'complex',
        code: 'COMPLEX_NAME_INVALID',
        message: `Complex "${name}" has ${members.length} components; a complex has ${COMPLEX_LIMITS.MIN_COMPONENTS} to ${COMPLEX_LIMITS.MAX_COMPONENTS}`,
      });
    }
    const seen = new Set<number>();
    for (const { row, component } of members) {
      if (seen.has(component)) {
        badGroup.add(key);
        errors.push({
          row,
          field: 'component',
          code: 'COMPONENT_INVALID',
          message: `Complex "${name}" has component ${component} twice`,
        });
      }
      seen.add(component);
    }
    if (members.some((m) => !m.ok)) badGroup.add(key);
  }

  const valid = rows.filter((r, i) => rowOk[i] && !badGroup.has(complexImportKey(r.complex)));
  return { valid, errors: errors.sort((a, b) => a.row - b.row) };
}

/**
 * Valid rows as complexes, in the order the file first names each, with components in `Component`
 * order. A complex takes the first row's spelling of its name.
 */
export function groupComplexImportRows(rows: readonly ComplexImportRow[]): ImportedComplex[] {
  const groups = new Map<string, { name: string; rows: ComplexImportRow[] }>();
  for (const r of rows) {
    const key = complexImportKey(r.complex);
    const group = groups.get(key) ?? { name: r.complex, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ name, rows: members }) => ({
    name,
    components: [...members].sort((a, b) => a.component - b.component).map(({ lift, reps }) => ({ lift, reps })),
  }));
}
