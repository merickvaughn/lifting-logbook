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
  pairWithRowNumber,
  buildSkippedDetail,
  liftRecordNaturalKey,
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
  // Never actually called: ImportController.commit special-cases 'lift-records' to
  // validate against a custom-lift-aware slot map (effectiveSlotMapFor) instead of
  // calling this closure (#911) — a bare DEFAULT_SLOT_MAP here would silently stop
  // recognizing a user's custom lifts. Throws rather than falling back to the wrong
  // slot map, so a future refactor that accidentally drops that special-case (e.g.
  // "simplifying" commit() to call handler.validate uniformly) fails loudly in tests
  // instead of silently regressing custom-lift recognition.
  validate: (): never => {
    throw new Error(
      "liftRecordsHandler.validate must not be called directly for 'lift-records' — " +
        'ImportController.commit validates this destination against a custom-lift-aware ' +
        'slot map via effectiveSlotMapFor instead (see effective-slot-map.util.ts, issue #911).',
    );
  },
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
    // Row numbers below are batch-relative — 1-based within *this* commit
    // batch, i.e. after any Phase 3 excludeKeys/splitDest filtering the
    // controller already applied. For a plain commit (neither) that matches
    // the original CSV data-row number; positions shift when rows were
    // excluded or split to a second destination ahead of this call. See
    // ImportCommitResponse.skippedDetail (issue #891) for the full contract.
    const rows = pairWithRowNumber(records);
    // Classify (and dedupe in-batch duplicates) in JS before writing, rather
    // than deriving `skipped` by subtracting the DB's insert count from the
    // unique-key count. That subtraction was sensitive to any drift between
    // the JS-side key and the DB-side constraint (issue #884); classifying
    // first means `toCreate` is already exactly what should be written, so
    // the DB's own `createMany({ skipDuplicates: true })` skip logic is
    // belt-and-suspenders rather than the source of truth for the count.
    const classified = [
      ...classifyImportRows(rows, ({ r }) => liftRecordNaturalKey(r), (_row, k) =>
        existingKeys.has(k) ? 'skip' : 'create',
      ),
    ];
    const toCreate = classified.filter((c) => c.kind === 'create').map((c) => c.row.r);
    const created = await repos.liftRecord.appendLiftRecords(program, toCreate);
    // `skipped` is derived from `created` (the DB's actual insert count), not
    // `toCreate.length` (what JS classification expected to write): a
    // concurrent import racing between findExistingRecords and
    // appendLiftRecords can insert a colliding row in between, so the DB
    // writes fewer rows than toCreate — deriving from toCreate.length would
    // silently drop that row from both totals. This keeps
    // created + skipped === classified.length (every input row accounted
    // for) even under that race; buildLiftRecordsPreImage(toCreate) is a
    // narrower residual — it still records the raced-out row as created for
    // undo purposes, since createMany's count doesn't say which row lost the
    // race. `skippedDetail` (via buildSkippedDetail) is narrower still — see
    // its doc comment for why a raced-out row has no entry there.
    return {
      created,
      updated: 0,
      skipped: classified.length - created,
      skippedDetail: buildSkippedDetail(classified),
      preImage: buildLiftRecordsPreImage(toCreate),
    };
  },
};

const trainingMaxesHandler: ImportHandler<TrainingMax> = {
  parse: parseTrainingMaxes,
  // Never actually called: ImportController special-cases 'training-maxes' to
  // validate against a custom-lift-aware slot map (effectiveSlotMapFor) instead
  // of calling this closure (#914) — validateTrainingMaxImport's own
  // DEFAULT_SLOT_MAP default parameter means a bare handler.validate(parsed)
  // call here would silently succeed with the wrong (non-custom-lift-aware)
  // result rather than failing loudly, so this throws instead, mirroring
  // liftRecordsHandler.validate below (issue #911) rather than leaving the
  // silently-wrong fallback reachable.
  validate: (): never => {
    throw new Error(
      "trainingMaxesHandler.validate must not be called directly for 'training-maxes' — " +
        'ImportController validates this destination against a custom-lift-aware slot map ' +
        'via effectiveSlotMapFor instead (see effective-slot-map.util.ts, issue #914).',
    );
  },
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
  // Never actually called: ImportController special-cases 'strength-goals' to
  // validate against a custom-lift-aware slot map (effectiveSlotMapFor) instead
  // of calling this closure (#914) — see trainingMaxesHandler.validate above for
  // why this throws rather than silently falling back to DEFAULT_SLOT_MAP.
  validate: (): never => {
    throw new Error(
      "strengthGoalsHandler.validate must not be called directly for 'strength-goals' — " +
        'ImportController validates this destination against a custom-lift-aware slot map ' +
        'via effectiveSlotMapFor instead (see effective-slot-map.util.ts, issue #914).',
    );
  },
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
