import { strToU8, zipSync } from 'fflate';
import {
  LiftRecordExportRow,
  serializeLiftRecords,
  serializeProgramSpec,
  serializeStrengthGoals,
  serializeTrainingMaxes,
  splitLiftRecordsForImport,
} from '@lifting-logbook/core';
import { UserDataRows } from '../ports/IUserDataExportRepository';
import { MAX_IMPORT_ROWS } from '../programs/import-file.util';

/** Bumped when `logbook.json` changes shape, so a future restore path can migrate older bundles. */
export const LOGBOOK_SCHEMA_VERSION = 1;

/** Row counts per table, the only thing the export logs about a user's data. */
export function rowCounts(rows: UserDataRows): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, value] of Object.entries(rows)) {
    counts[table] = Array.isArray(value) ? value.length : value === null ? 0 : 1;
  }
  counts['customProgramSpecs'] = rows.customPrograms.reduce((sum, p) => sum + p.specs.length, 0);
  return counts;
}

/**
 * A custom lift's name in place of its id: it reads in a spreadsheet, and import resolves either,
 * but only the name means anything on another account.
 */
export function liftRecordsWithLiftNames(rows: UserDataRows): LiftRecordExportRow[] {
  const names = new Map(rows.customLifts.map((lift) => [lift.id, lift.name]));
  return rows.liftRecords.map((r) => ({ ...r, lift: names.get(r.lift) ?? r.lift }));
}

/**
 * The archive's files, path to text.
 *
 * Lift records cover every program, since their `Program` column says which. Training maxes,
 * strength goals and program specs can't name a program: `/import` takes it from the URL. So the
 * root holds those for the active program, and each other program with any gets its own folder.
 * Built-in programs have no spec rows of their own, so their `program-spec.csv` is a header.
 */
export function buildExportFiles(rows: UserDataRows, now: Date): Record<string, string> {
  const maxesFor = (program: string) => rows.trainingMaxes.filter((m) => m.program === program);
  const goalsFor = (program: string) => rows.strengthGoals.filter((g) => g.program === program);
  const specsFor = (program: string) => rows.customPrograms.find((p) => p.id === program)?.specs ?? [];

  const parts = splitLiftRecordsForImport(liftRecordsWithLiftNames(rows), MAX_IMPORT_ROWS);
  const files: Record<string, string> = {};
  if (parts.length > 1) {
    parts.forEach((part, i) => {
      files[`lift-records-part-${i + 1}.csv`] = serializeLiftRecords(part);
    });
  } else {
    files['lift-records.csv'] = serializeLiftRecords(parts[0] ?? []);
  }

  const programs = [
    ...new Set([
      ...rows.trainingMaxes.map((m) => m.program),
      ...rows.strengthGoals.map((g) => g.program),
      ...rows.customPrograms.filter((p) => p.specs.length > 0).map((p) => p.id),
    ]),
  ].sort();
  const rootProgram = rows.userSettings?.activeProgram ?? programs[0];

  files['training-maxes.csv'] = serializeTrainingMaxes(rootProgram ? maxesFor(rootProgram) : []);
  files['strength-goals.csv'] = serializeStrengthGoals(rootProgram ? goalsFor(rootProgram) : [], now);
  files['program-spec.csv'] = serializeProgramSpec(rootProgram ? specsFor(rootProgram) : []);

  const folders = new Set<string>();
  for (const program of programs.filter((p) => p !== rootProgram)) {
    const folder = uniqueFolder(program, rows, folders);
    if (maxesFor(program).length > 0) {
      files[`${folder}/training-maxes.csv`] = serializeTrainingMaxes(maxesFor(program));
    }
    if (goalsFor(program).length > 0) {
      files[`${folder}/strength-goals.csv`] = serializeStrengthGoals(goalsFor(program), now);
    }
    if (specsFor(program).length > 0) {
      files[`${folder}/program-spec.csv`] = serializeProgramSpec(specsFor(program));
    }
  }

  files['logbook.json'] = JSON.stringify(
    { schemaVersion: LOGBOOK_SCHEMA_VERSION, exportedAt: now.toISOString(), tables: rows },
    null,
    2,
  );
  return files;
}

/**
 * Program keys and custom program names are the user's text, so the path keeps only safe
 * characters. That can make two programs equal, hence the counter. A custom program also gets
 * part of its id, because its name alone doesn't identify it and its key is an opaque uuid.
 */
function uniqueFolder(program: string, rows: UserDataRows, taken: Set<string>): string {
  const custom = rows.customPrograms.find((p) => p.id === program);
  const label = custom ? `${custom.name}-${program.slice(0, 8)}` : program;
  const safe = label
    .replace(/[^A-Za-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const base = `other-programs/${safe || 'program'}`;
  let folder = base;
  for (let n = 2; taken.has(folder); n++) folder = `${base}-${n}`;
  taken.add(folder);
  return folder;
}

export function zipExportFiles(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
  );
}

export function exportFileName(now: Date): string {
  return `lifting-logbook-export-${now.toISOString().slice(0, 10)}.zip`;
}
