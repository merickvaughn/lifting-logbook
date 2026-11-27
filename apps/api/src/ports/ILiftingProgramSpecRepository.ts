import { LiftingProgramSpec } from '@lifting-logbook/core';
import { ImportWriteResult } from '@lifting-logbook/types';

/**
 * Counts returned by an idempotent program-spec write. Alias of the shared
 * {@link ImportWriteResult} so every import-commit kind reports the same shape.
 */
export type SaveProgramSpecResult = ImportWriteResult;

export interface ILiftingProgramSpecRepository {
  getProgramSpec(program: string): Promise<LiftingProgramSpec[]>;

  /**
   * Idempotently writes program-spec rows for a **custom** program, keyed by
   * (week, offset, lift, order): a new key inserts, an existing key with changed
   * config updates, an identical key is skipped. Re-running the same import
   * yields `created: 0`.
   *
   * Built-in template programs are immutable seed data — implementations throw
   * when `program` is not a custom (UUID) program id.
   *
   * Naming asymmetry (intentional, #532): the training-max and strength-goal
   * repositories expose a pure write (`saveTrainingMaxes` / `upsertGoal`) **and**
   * a separate import-commit method (`importTrainingMaxes` / `importGoals`).
   * Program spec has only ever had one write path — `saveProgramSpec`, which is
   * already idempotent and transactional — so it doubles as the import-commit
   * method without a separate `importProgramSpec`. The shape is unified (returns
   * the shared {@link SaveProgramSpecResult} = `ImportWriteResult`, classifies via
   * the shared `programSpecRowKind` + `classifyAndCount`); only the name differs.
   */
  saveProgramSpec(
    program: string,
    rows: LiftingProgramSpec[],
  ): Promise<SaveProgramSpecResult>;

  /**
   * Throws what {@link saveProgramSpec} would throw before writing: a 400 when `program` isn't a
   * custom program id, and a 404 when the user doesn't own it. An import dry run calls it so it
   * refuses what the commit refuses (#1160).
   */
  assertWritable(program: string): Promise<void>;

  /**
   * Deletes program-spec rows by natural key for undo support.
   * Each key is encoded as `"week:offset:lift:order"`.
   */
  deleteSpecRows(program: string, naturalKeys: string[]): Promise<void>;
}
