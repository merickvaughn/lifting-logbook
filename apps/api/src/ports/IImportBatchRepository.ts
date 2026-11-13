import { ImportPreImage } from '@lifting-logbook/core';
import { ImportKind } from '@lifting-logbook/types';

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
}

/**
 * How a lift-records pre-image key's macrocycle number is read: the leading number of a set key
 * (`<n>:…`, current and date-blind legacy forms alike) or of a `legacy` row's key
 * (`macrocycle-row:<n>`). JavaScript and Postgres read it alike, so the Prisma adapter filters
 * batches in SQL with the same pattern {@link preImageKeyNumber} uses. Two kinds of key hold no
 * number and read as null: a 1RM split's training max, keyed by lift id, and a non-cycle set,
 * keyed `non-cycle:<natural key>` (#1184).
 */
export const PRE_IMAGE_KEY_NUMBER = '^(?:macrocycle-row:)?([0-9]+)(?::|$)';

const preImageKeyNumberPattern = new RegExp(PRE_IMAGE_KEY_NUMBER);

/** The macrocycle number a lift-records pre-image key holds, else null. */
export function preImageKeyNumber(key: string): number | null {
  const num = preImageKeyNumberPattern.exec(key)?.[1];
  return num === undefined ? null : Number(num);
}

/** A key's number is one of `on`, or any number but those in `except`. */
export type KeyNumbers = { on: readonly number[] } | { except: readonly number[] };

export interface IImportBatchRepository {
  save(batch: ImportBatchRecord): Promise<void>;
  findById(id: string, userId: string): Promise<ImportBatchRecord | null>;
  /** The user's batches whose `groupId` is `groupId`: the other programs' batches of that import. */
  listGroup(groupId: string): Promise<ImportBatchRecord[]>;
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
}
