import { ImportPreImage } from '@lifting-logbook/core';
import { ImportKind } from '@lifting-logbook/types';

export interface ImportBatchRecord {
  id: string;
  userId: string;
  program: string;
  destination: ImportKind;
  preImage: ImportPreImage;
  createdAt: Date;
}

/**
 * How a lift-records pre-image key's macrocycle number is read: the leading number of a set key
 * (`<n>:…`, current and date-blind legacy forms alike) or of a `legacy` row's key
 * (`macrocycle-row:<n>`). JavaScript and Postgres read it alike, so the Prisma adapter filters
 * batches in SQL with the same pattern {@link preImageKeyNumber} uses.
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
  deleteById(id: string, userId: string): Promise<void>;
  /**
   * The user's batches of one program and destination with a pre-image key whose number
   * ({@link preImageKeyNumber}) is `which`, filtered in the database so a renumbering or a
   * delete loads only the batches it changes.
   */
  listWithKeysOn(program: string, destination: ImportKind, which: KeyNumbers): Promise<ImportBatchRecord[]>;
  /** Replaces a batch's pre-image, as a renumbering does to the keys that hold a number. */
  updatePreImage(id: string, preImage: ImportPreImage): Promise<void>;
}
