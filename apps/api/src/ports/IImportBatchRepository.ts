import { ImportPreImage, LiftOverride, Weekday } from '@lifting-logbook/core';
import { FocusDayState, ImportKind } from '@lifting-logbook/types';
import { MacrocycleOrigin, MacrocycleStatus } from '@lifting-logbook/types';

export interface ImportBatchRecord {
  id: string;
  userId: string;
  program: string;
  destination: ImportKind;
  preImage: ImportPreImage;
  createdAt: Date;
  /**
   * The id of the Source program's batch of the same import, which undoes this one with it
   * (#1254). Absent on that batch and on every import that stores under one program.
   */
  groupId?: string | null;
  /**
   * The macrocycles an import through the Assign step created or extended, by stable id
   * (#1255, decision 14), kept apart from `preImage`'s lift-record keys, with the statuses it
   * chose for them. Undo releases those choices, then recomputes each macrocycle from the sets
   * left on it. Absent on every other import.
   */
  macrocycles?: BatchMacrocycles | null;
}

/**
 * A status the lifter chose for a stretch, which a batch set on the macrocycle the stretch created
 * or joined (#1255): the status chosen, and the macrocycle's status as the batch found it. A
 * created macrocycle had none, so it was found unchosen.
 */
export interface StatusChoice {
  id: string;
  chose: MacrocycleStatus;
  before: { status?: MacrocycleStatus; statusChosen: boolean };
}

/** See {@link ImportBatchRecord.macrocycles}. */
export interface BatchMacrocycles {
  created: string[];
  extended: string[];
  /** The statuses this batch chose, one per macrocycle. Undo orders choices across batches by `createdAt`, then `id`. */
  chosen: StatusChoice[];
  /** The run this batch continued as its program's current macrocycle (#1180). Absent on every other batch. */
  continued?: ContinuedRun;
  /**
   * The backup of what this import replaced (#1182, decision 19), which undo restores. On the
   * Source program's batch of an overwrite only.
   */
  overwrite?: { snapshotId: string };
}

/**
 * What continuing a run as current changed besides its sets and training maxes (#1180, decision
 * 2), as undo puts it back. Macrocycles are kept by stable id, since their numbers can change. It's
 * stored as JSON, so the ended macrocycle's end date is a `YYYY-MM-DD` string and the dashboard's
 * date an ISO timestamp.
 */
export interface ContinuedRun {
  /** The run's macrocycle, created `live`. */
  id: string;
  /** The live macrocycle continuing ended, with its end date and status before, or null with none. */
  ended: { id: string; endDate: string | null; status: MacrocycleStatus } | null;
  /**
   * The live macrocycle continuing removed rather than ended, since it held no sets (#1354). Absent
   * otherwise, and on every batch from before #1354. `ended` is then null.
   */
  removed?: RemovedMacrocycle;
  /**
   * The program's dashboard before, which pointed at `ended` or `removed`, without its number,
   * which undo reads from that macrocycle again. Null when the program had none.
   */
  dashboard: {
    macrocycleUnit: string;
    macrocycleDate: string;
    sheetName: string;
    macrocycleStartWeekday: Weekday;
    programType: string | null;
  } | null;
  /** The active program before. */
  activeProgram: string | null;
}

/**
 * A live macrocycle with no sets that continuing a run removed (#1354), as undo recreates it: its
 * row, under the same id, its schedule, and its workouts' overrides and focus day states (#1359).
 * Its number isn't kept, since undo numbers it by date. Its dates are `YYYY-MM-DD` strings, and
 * its scheduled workouts' and rescheduled workouts' ISO timestamps. A batch from before #1359 has
 * no overrides or focus day states recorded, and reads with none. A type rather than an
 * interface, so it's assignable to the JSON column's type.
 */
export type RemovedMacrocycle = {
  id: string;
  startDate: string;
  endDate: string | null;
  status: MacrocycleStatus;
  statusChosen: boolean;
  origin: MacrocycleOrigin;
  unmatched: boolean;
  importedThrough: string | null;
  schedule: Array<{ workoutNum: number; weekNum: number; scheduledDate: string }>;
  /** Rescheduled workouts. */
  dateOverrides: Array<{ workoutNum: number; newDate: string }>;
  /** Skipped workouts, with the reason given, if any. */
  skips: Array<{ workoutNum: number; reason: string | null }>;
  /** Each workout's lift overrides, in the order they were saved, which undo saves them in. */
  liftOverrides: Array<{ workoutNum: number; overrides: Array<JsonCopy<LiftOverride>> }>;
  /** Saved focus choices. */
  focus: Array<{ workoutNum: number; state: JsonCopy<FocusDayState> }>;
};

/** An interface's fields as a type, which, unlike the interface, is assignable to a JSON type. */
type JsonCopy<T> = { [K in keyof T]: T[K] };

/**
 * How a lift-records pre-image key's macrocycle number is read: the leading number of a set key
 * (`<n>:…`, current and date-blind legacy forms alike) or of a `legacy` row's key
 * (`macrocycle-row:<n>`). JavaScript and Postgres read it alike, so the Prisma adapter filters
 * batches in SQL with the same pattern {@link preImageKeyNumber} uses. Two kinds of key hold no
 * number and read as null: a 1RM split's training max, keyed by lift id, and a non-cycle set,
 * keyed `non-cycle:<natural key>` (#1184). A key on a negative macrocycle number reads as null
 * too, since the pattern allows no sign; undo reads keys with {@link signedPreImageKeyNumber}
 * instead (#1235), and #1485 tracks the other readers.
 */
export const PRE_IMAGE_KEY_NUMBER = '^(?:macrocycle-row:)?([0-9]+)(?::|$)';

const preImageKeyNumberPattern = new RegExp(PRE_IMAGE_KEY_NUMBER);

/** The macrocycle number a lift-records pre-image key holds, else null. */
export function preImageKeyNumber(key: string): number | null {
  const num = preImageKeyNumberPattern.exec(key)?.[1];
  return num === undefined ? null : Number(num);
}

/**
 * {@link PRE_IMAGE_KEY_NUMBER} with a sign allowed, as the #1200 migration's `key_number` reads
 * it. A number stored before #1224 checked its range, or one `macrocycle_renumber_reverse()` put
 * back, can be negative (#1235).
 */
const signedKeyNumberPattern = /^(?:macrocycle-row:)?(-?[0-9]+)(?::|$)/;

/**
 * The macrocycle number a lift-records pre-image key holds, negative ones included, else null.
 * Undo tells sets and `legacy` rows from training maxes with it, so a set on a negative number
 * is deleted rather than read as a training max (#1235).
 */
export function signedPreImageKeyNumber(key: string): number | null {
  const num = signedKeyNumberPattern.exec(key)?.[1];
  return num === undefined ? null : Number(num);
}

/** A key's number is one of `on`, or any number but those in `except`. */
export type KeyNumbers = { on: readonly number[] } | { except: readonly number[] };

/**
 * The keys of a lift-records pre-image that hold a number and that the batch created: its sets and
 * `legacy` rows, which undo deletes and whose macrocycles it reads again. The Prisma adapter's
 * {@link IImportBatchRepository.listSummaries} applies the same rule in SQL.
 */
export function createdNumberedKeys(preImage: ImportPreImage): string[] {
  return Object.entries(preImage)
    .filter(([key, entry]) => preImageKeyNumber(key) !== null && entry.kind === 'created')
    .map(([key]) => key);
}

/**
 * A lift-records batch as the import list reads it (#1257): the numbers its created keys hold
 * rather than its pre-image, which can run to thousands of keys. The training-maxes list (#1405)
 * reads only `id`, `program` and `createdAt`: such a batch is never grouped, touches no
 * macrocycle and holds no numbered key.
 */
export interface ImportBatchSummaryRecord {
  id: string;
  program: string;
  createdAt: Date;
  /** The Source program's batch of the same import, when this one is grouped under it and it still exists (#1254). */
  source: { id: string; program: string; createdAt: Date } | null;
  /** See {@link ImportBatchRecord.macrocycles}. */
  macrocycles: BatchMacrocycles | null | undefined;
  /** The distinct numbers ({@link preImageKeyNumber}) of {@link createdNumberedKeys}. */
  createdNums: number[];
}

export interface IImportBatchRepository {
  save(batch: ImportBatchRecord): Promise<void>;
  findById(id: string, userId: string): Promise<ImportBatchRecord | null>;
  /** The user's batches whose `groupId` is `groupId`: the other programs' batches of that import. */
  listGroup(groupId: string): Promise<ImportBatchRecord[]>;
  /** The user's batches of one program and destination, newest first, as summaries (#1257, #1405). */
  listSummaries(program: string, destination: ImportKind): Promise<ImportBatchSummaryRecord[]>;
  deleteById(id: string, userId: string): Promise<void>;
  /**
   * The user's batches of one program and destination with a pre-image key whose number
   * ({@link preImageKeyNumber}) is `which`, filtered in the database so a renumbering or a
   * delete loads only the batches it changes.
   */
  listWithKeysOn(program: string, destination: ImportKind, which: KeyNumbers): Promise<ImportBatchRecord[]>;
  /**
   * The user's batches of one destination, under any program, holding at least one of `keys`,
   * filtered in the database. A non-cycle set's key is the same whichever program's import
   * created it, so deleting a non-cycle workout looks its keys up this way (#1184).
   */
  listWithKeys(destination: ImportKind, keys: readonly string[]): Promise<ImportBatchRecord[]>;
  /**
   * Replaces the pre-image of each of the user's batches named, in one statement, as a renumbering
   * or a delete does to the keys that hold a number.
   */
  updatePreImages(updates: ReadonlyArray<{ id: string; preImage: ImportPreImage }>): Promise<void>;
  /** The user's batches holding a status choice for the macrocycle with this id (#1255), filtered in the database. */
  listChoosing(macrocycleId: string): Promise<ImportBatchRecord[]>;
  /** Replaces one of the user's batches' `macrocycles`, as undo does to hand a choice's `before` on. */
  updateMacrocycles(id: string, macrocycles: BatchMacrocycles): Promise<void>;
  /**
   * The user's batches, under any program, that replaced stored history (#1182): those whose
   * `macrocycles` names a snapshot, filtered in the database, with that snapshot's id. Undo
   * refuses an overwrite while a later one that can still be undone is here.
   */
  listOverwrites(): Promise<Array<{ id: string; createdAt: Date; snapshotId: string }>>;
  /** Those of `ids` that are the user's batches, in one read. */
  listByIds(ids: readonly string[]): Promise<ImportBatchRecord[]>;
}
