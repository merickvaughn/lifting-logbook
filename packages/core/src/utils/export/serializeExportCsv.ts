import { NON_CYCLE_PROGRAM } from '@lifting-logbook/types';
import {
  LIFT_RECORD_HEADER_MAP,
  LIFTING_PROGRAM_SPEC_HEADER_MAP,
  TRAINING_MAX_HEADER_MAP,
} from '../../constants';
import { SpreadsheetCell } from '../../models';
import { serializeCsvText } from '../parser/serializeCsvText';

/**
 * The CSV shapes the importer reads back, for Download My Data (#947) and the filtered export
 * (#1181). These take stored rows, so their strings are plain `string` rather than the narrower
 * model types.
 */

export interface LiftRecordExportRow {
  program: string;
  macrocycleNum: number;
  workoutNum: number;
  date: Date;
  lift: string;
  occurrence: number;
  setNum: number;
  weight: number;
  reps: number;
  notes: string;
  modifications: readonly string[];
}

export interface TrainingMaxExportRow {
  dateUpdated: Date;
  lift: string;
  weight: number;
}

export interface StrengthGoalExportRow {
  lift: string;
  goalType: string;
  target?: number | null;
  ratio?: number | null;
  unit: string;
}

export interface ProgramSpecExportRow {
  week: number;
  offset: number;
  lift: string;
  increment: number;
  order: number;
  sets: number;
  reps: number;
  amrap: string | boolean;
  warmUpPct: string;
  wtDecrementPct: number;
  activation: string;
  weekType?: string | null;
}

/**
 * The column only this app's lift-record export writes. Import reads a file that has it as an
 * export (the classifier's `exportToken`, `isLiftRecordExport`), so they all key on this name.
 */
export const LIFT_RECORD_EXPORT_TOKEN = 'Occurrence';

/**
 * Decision 22 of docs/proposals/2026-11-06-import-macrocycle-assignment.md: the lift-record
 * headers plus three optional columns. A file with `Occurrence` is treated as an export, so
 * this column is always written, 0 included.
 */
export const LIFT_RECORD_EXPORT_HEADERS: readonly string[] = [
  ...Object.keys(LIFT_RECORD_HEADER_MAP),
  LIFT_RECORD_EXPORT_TOKEN,
  'Modifications',
  'Status',
];

/** Joins a set's modification ids in the `Modifications` column. Ids are uuids, so never contain it. */
const LIFT_RECORD_MODIFICATION_SEPARATOR = ';';

const FORMULA_TRIGGER = /^[=+\-@\t\r\n]/;

/**
 * A leading apostrophe on text a spreadsheet would run as a formula (decision 22). Only for free
 * text: a negative weight is a number and stays as it is.
 */
export function escapeCsvFormula(text: string): string {
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/**
 * `Status` is written empty until the macrocycle table holds one (#1171). A status in this column
 * counts as one the lifter chose (decision 22), so an empty cell is the only value that stays
 * correct when a file exported now is imported later.
 */
export function serializeLiftRecords(records: readonly LiftRecordExportRow[]): string {
  return serializeCsvText([
    LIFT_RECORD_EXPORT_HEADERS,
    ...records.map((r) => [
      escapeCsvFormula(r.program),
      r.macrocycleNum,
      r.workoutNum,
      r.date,
      escapeCsvFormula(r.lift),
      r.setNum,
      r.weight,
      r.reps,
      escapeCsvFormula(r.notes),
      r.occurrence,
      r.modifications.join(LIFT_RECORD_MODIFICATION_SEPARATOR),
      '',
    ]),
  ]);
}

/**
 * Splits records into parts of at most `maxRows`, oldest macrocycle first, so each part can be
 * uploaded in turn. Parts are cut between macrocycles. One macrocycle over the limit can't stay
 * whole, so it's cut in date order: its rows still carry their macrocycle number. Non-cycle
 * workouts have no macrocycle boundaries, so they're cut between workouts. Rows keep their input
 * order within a workout.
 */
export function splitLiftRecordsForImport<T extends LiftRecordExportRow>(
  records: readonly T[],
  maxRows: number,
): T[][] {
  // Oldest first, so a Map keeps macrocycles in order of their first row.
  const oldestFirst = [...records].sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.program.localeCompare(b.program) ||
      a.macrocycleNum - b.macrocycleNum ||
      a.workoutNum - b.workoutNum,
  );
  const groups = new Map<string, T[]>();
  for (const record of oldestFirst) {
    const key = JSON.stringify(
      record.program === NON_CYCLE_PROGRAM
        ? [record.program, record.macrocycleNum, record.workoutNum]
        : [record.program, record.macrocycleNum],
    );
    const rows = groups.get(key);
    if (rows) rows.push(record);
    else groups.set(key, [record]);
  }

  const parts: T[][] = [];
  let current: T[] = [];
  for (const rows of groups.values()) {
    if (current.length > 0 && current.length + rows.length > maxRows) {
      parts.push(current);
      current = [];
    }
    let start = 0;
    for (; rows.length - start > maxRows; start += maxRows) {
      parts.push(rows.slice(start, start + maxRows));
    }
    current.push(...rows.slice(start));
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export function serializeTrainingMaxes(maxes: readonly TrainingMaxExportRow[]): string {
  return serializeCsvText([
    Object.keys(TRAINING_MAX_HEADER_MAP),
    ...maxes.map((m) => [m.dateUpdated, escapeCsvFormula(m.lift), m.weight]),
  ]);
}

const STRENGTH_GOAL_HEADERS = ['Lift', 'Current TM', 'Intermediate', 'Advanced', 'Elite', 'Ratio', 'Unit'];

/**
 * The tier ladder `parseStrengthGoals` reads, which the classifier needs to recognize the file.
 * A stored goal has one value, so an absolute goal fills the first tier with `Current TM` empty,
 * which the parser takes as the goal. `Ratio` and `Unit` carry what the ladder can't: relative
 * goals, the default in the app, and goals in kg.
 */
export function serializeStrengthGoals(goals: readonly StrengthGoalExportRow[], today: Date): string {
  const row = (first: string, ...rest: SpreadsheetCell[]): SpreadsheetCell[] => [
    first,
    ...rest,
    ...Array<SpreadsheetCell>(STRENGTH_GOAL_HEADERS.length - 1 - rest.length).fill(''),
  ];
  return serializeCsvText([
    row("Today's Date", today),
    STRENGTH_GOAL_HEADERS,
    ...goals.map((g) =>
      // Older rows are `relative` with a target and no ratio, so this follows the value they hold.
      g.goalType === 'relative' && g.ratio != null
        ? row(escapeCsvFormula(g.lift), '', '', '', '', g.ratio, g.unit)
        : row(escapeCsvFormula(g.lift), '', g.target ?? null, '', '', '', g.unit),
    ),
    row('Goal Date', 'N/A'),
  ]);
}

export function serializeProgramSpec(rows: readonly ProgramSpecExportRow[]): string {
  return serializeCsvText([
    Object.keys(LIFTING_PROGRAM_SPEC_HEADER_MAP),
    ...rows.map((r) => [
      r.week,
      r.offset,
      escapeCsvFormula(r.lift),
      r.increment,
      r.order,
      r.sets,
      r.reps,
      r.amrap === true || r.amrap === 'TRUE',
      escapeCsvFormula(r.warmUpPct),
      r.wtDecrementPct,
      escapeCsvFormula(r.activation),
      escapeCsvFormula(r.weekType ?? ''),
    ]),
  ]);
}
