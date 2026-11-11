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

export interface IImportBatchRepository {
  save(batch: ImportBatchRecord): Promise<void>;
  findById(id: string, userId: string): Promise<ImportBatchRecord | null>;
  deleteById(id: string, userId: string): Promise<void>;
  /** The user's batches of one program and destination, for a delete to drop their stale keys. */
  listForProgram(program: string, destination: ImportKind): Promise<ImportBatchRecord[]>;
  /**
   * The user's batches of one program and destination with a pre-image key on one of
   * `macrocycleNums` (`<n>:…`, or `macrocycle-row:<n>`), filtered in the database so a
   * renumbering loads only the batches it changes.
   */
  listWithKeysOn(program: string, destination: ImportKind, macrocycleNums: readonly number[]): Promise<ImportBatchRecord[]>;
  /** Replaces a batch's pre-image, as a renumbering does to the keys that hold a number. */
  updatePreImage(id: string, preImage: ImportPreImage): Promise<void>;
}
