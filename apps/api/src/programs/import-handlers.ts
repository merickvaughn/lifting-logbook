import {
  ImportError,
  ImportKind,
  ImportPreviewResponse,
  ImportCommitResponse,
} from '@lifting-logbook/types';
import {
  SpreadsheetCell,
  LiftRecord,
  TrainingMax,
  StrengthGoalEntry,
  LiftingProgramSpec,
  ImportPreImage,
  parseLiftRecords,
  parseTrainingMaxes,
  parseStrengthGoals,
  parseLiftingProgramSpec,
  validateLiftImport,
  validateTrainingMaxImport,
  validateStrengthGoalImport,
  validateProgramSpecImport,
  buildLiftRecordsPreview,
  buildTrainingMaxPreview,
  buildStrengthGoalPreview,
  buildProgramSpecPreview,
  buildLiftRecordsPreImage,
  buildTrainingMaxPreImage,
  buildStrengthGoalPreImage,
  buildProgramSpecPreImage,
  classifyImportRows,
  liftRecordNaturalKey,
  DEFAULT_SLOT_MAP,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';

export interface ImportHandler<T> {
  parse(table: SpreadsheetCell[][]): T[];
  validate(parsed: T[]): { valid: T[]; errors: ImportError[] };
  preview(
    valid: T[],
    program: string,
    repos: RepositoryBundle,
  ): Promise<ImportPreviewResponse['preview']>;
  commit(
    valid: T[],
    program: string,
    repos: RepositoryBundle,
  ): Promise<Omit<ImportCommitResponse, 'destination' | 'batchId' | 'split'> & { preImage: ImportPreImage }>;
}

const liftRecordsHandler: ImportHandler<LiftRecord> = {
  parse: parseLiftRecords,
  validate: (parsed) => validateLiftImport(parsed, DEFAULT_SLOT_MAP),
  async preview(valid, program, repos) {
    const records = valid.map((r) => ({ ...r, program }));
    const existing = await repos.liftRecord.findExistingRecords(program, records);
    return buildLiftRecordsPreview(records, existing);
  },
  async commit(valid, program, repos) {
    const records = valid.map((r) => ({ ...r, program }));
    const existingKeys = new Set(
      (await repos.liftRecord.findExistingRecords(program, records)).map(liftRecordNaturalKey),
    );
    // Classify (and dedupe in-batch duplicates) in JS before writing, rather
    // than deriving `skipped` by subtracting the DB's insert count from the
    // unique-key count. That subtraction was sensitive to any drift between
    // the JS-side key and the DB-side constraint (issue #884); classifying
    // first means `toCreate` is already exactly what should be written, so
    // the DB's own `createMany({ skipDuplicates: true })` skip logic is
    // belt-and-suspenders rather than the source of truth for the count.
    const classified = [
      ...classifyImportRows(records, liftRecordNaturalKey, (_r, k) =>
        existingKeys.has(k) ? 'skip' : 'create',
      ),
    ];
    const toCreate = classified.filter((c) => c.kind === 'create').map((c) => c.row);
    const created = await repos.liftRecord.appendLiftRecords(program, toCreate);
    return {
      created,
      updated: 0,
      skipped: classified.length - toCreate.length,
      preImage: buildLiftRecordsPreImage(toCreate),
    };
  },
};

const trainingMaxesHandler: ImportHandler<TrainingMax> = {
  parse: parseTrainingMaxes,
  validate: validateTrainingMaxImport,
  async preview(valid, program, repos) {
    const existing = await repos.trainingMax.getTrainingMaxes(program);
    return buildTrainingMaxPreview(valid, existing);
  },
  async commit(valid, program, repos) {
    const existing = await repos.trainingMax.getTrainingMaxes(program);
    const result = await repos.trainingMax.importTrainingMaxes(program, valid);
    return { ...result, preImage: buildTrainingMaxPreImage(valid, existing) };
  },
};

const strengthGoalsHandler: ImportHandler<StrengthGoalEntry> = {
  parse: parseStrengthGoals,
  validate: validateStrengthGoalImport,
  async preview(valid, program, repos) {
    const existing = await repos.strengthGoal.getGoals(program);
    return buildStrengthGoalPreview(valid, existing);
  },
  async commit(valid, program, repos) {
    const existing = await repos.strengthGoal.getGoals(program);
    const result = await repos.strengthGoal.importGoals(program, valid);
    return { ...result, preImage: buildStrengthGoalPreImage(valid, existing) };
  },
};

const programSpecHandler: ImportHandler<LiftingProgramSpec> = {
  parse: parseLiftingProgramSpec,
  validate: validateProgramSpecImport,
  async preview(valid, program, repos) {
    const existing = await repos.liftingProgramSpec.getProgramSpec(program);
    return buildProgramSpecPreview(valid, existing);
  },
  async commit(valid, program, repos) {
    const existing = await repos.liftingProgramSpec.getProgramSpec(program);
    const result = await repos.liftingProgramSpec.saveProgramSpec(program, valid);
    return { ...result, preImage: buildProgramSpecPreImage(valid, existing) };
  },
};

export const IMPORT_HANDLERS: Record<ImportKind, ImportHandler<LiftRecord | TrainingMax | StrengthGoalEntry | LiftingProgramSpec>> = {
  'lift-records': liftRecordsHandler,
  'training-maxes': trainingMaxesHandler,
  'strength-goals': strengthGoalsHandler,
  'program-spec': programSpecHandler,
};
