import {
  ImportError,
  ImportKind,
  ImportPreview,
  ImportCommitResponse,
  NON_CYCLE_PROGRAM,
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
  classifyLiftRecordRows,
  ClassifiedLiftRecordRow,
  pairWithRowNumber,
  buildSkippedDetail,
  liftRecordLabel,
  withImportProgram,
  withOccurrence,
} from '@lifting-logbook/core';
import { RepositoryBundle } from '../ports/factory';
import { liftNamesFor } from './effective-slot-map.util';
import { legacyRowsPreImage, lockForImport, nonCycleRowsPreImage, placeFileRows } from './macrocycle-history.util';
import {
  NON_CYCLE_MACROCYCLE_NUM,
  ensureNonCycleRow,
  nextNonCycleWorkoutNum,
} from './non-cycle.util';
import { renumberProgram } from './macrocycle-renumbering';

export interface ImportHandler<T> {
  parse(table: SpreadsheetCell[][]): T[];
  validate(parsed: T[]): { valid: T[]; errors: ImportError[] };
  preview(
    valid: T[],
    program: string,
    repos: RepositoryBundle,
  ): Promise<ImportPreview>;
  commit(
    valid: T[],
    program: string,
    repos: RepositoryBundle,
  ): Promise<Omit<ImportCommitResponse, 'destination' | 'batchId' | 'split'> & { preImage: ImportPreImage }>;
}

/**
 * Writes the rows of an import path that takes macrocycle numbers from a file
 * (`POST lift-records/import` and flag-off commits), under the lock the caller holds exclusively.
 * Rows are classified by counting against what's stored (proposal decision 13) in JS before
 * writing, so `toCreate` is exactly what should be written and `createMany`'s
 * `skipDuplicates` is a backstop (#884). The file's numbers then only group the rows
 * (`placeFileRows`), and the program renumbers by date. `toCreate` and `legacyNums` carry the
 * numbers as stored after that, for the batch's pre-image.
 */
export async function writeFileNumberRows(
  repos: Pick<RepositoryBundle, 'liftRecord' | 'macrocycle' | 'macrocycleDashboard' | 'importBatch'>,
  program: string,
  records: LiftRecord[],
): Promise<{
  classified: ClassifiedLiftRecordRow<{ r: LiftRecord; row: number }, LiftRecord>[];
  toCreate: LiftRecord[];
  /** The non-cycle rows created, as stored. */
  nonCycle: LiftRecord[];
  created: number;
  legacyNums: number[];
}> {
  const classified = classifyLiftRecordRows(pairWithRowNumber(records), ({ r }) => r, await repos.liftRecord.findStoredSets(records));
  const allCreating = classified
    .filter((c) => c.kind === 'create')
    .map(({ row: { r }, occurrence }) => {
      const { occurrence: _fileOccurrence, ...rest } = r;
      return { ...rest, ...withOccurrence(occurrence) };
    });
  // A row whose `Program` is `non-cycle` is stored as a non-cycle workout (decision 23, #1184).
  const creating = allCreating.filter((r) => r.program !== NON_CYCLE_PROGRAM);
  const nonCycle = await placeNonCycleRows(
    repos,
    allCreating.filter((r) => r.program === NON_CYCLE_PROGRAM),
  );
  // The program's macrocycles each file number's skipped rows were found in.
  const pairedNums = new Map<number, Set<number>>();
  for (const { row: { r }, paired } of classified) {
    if (paired?.program !== program || r.program === NON_CYCLE_PROGRAM) continue;
    pairedNums.set(r.macrocycleNum, (pairedNums.get(r.macrocycleNum) ?? new Set<number>()).add(paired.macrocycleNum));
  }
  const { nums, legacyNums } = await placeFileRows(repos, program, creating, pairedNums);
  const placedRows = creating.map((r, i) => ({ ...r, macrocycleNum: nums[i] ?? r.macrocycleNum }));
  const created =
    (await repos.liftRecord.appendLiftRecords(program, placedRows)) +
    (nonCycle.length > 0 ? await repos.liftRecord.appendLiftRecords(NON_CYCLE_PROGRAM, nonCycle) : 0);
  const changes = await renumberProgram(repos, program);
  const renumbered = (n: number) => changes.get(n) ?? n;
  return {
    classified,
    toCreate: placedRows.map((r) => ({ ...r, macrocycleNum: renumbered(r.macrocycleNum) })),
    nonCycle,
    created,
    legacyNums: legacyNums.map(renumbered),
  };
}

/**
 * Numbers a file's non-cycle rows as workouts after every stored one, one workout per date and
 * file workout number in date order, so two on one date stay separate and nothing joins a
 * stored workout. The non-cycle macrocycle gets its row on first use. The caller holds the lock
 * exclusively, as starting a non-cycle workout does.
 */
async function placeNonCycleRows(
  repos: Pick<RepositoryBundle, 'liftRecord' | 'macrocycle'>,
  rows: LiftRecord[],
): Promise<LiftRecord[]> {
  if (rows.length === 0) return [];
  const groupOf = (r: LiftRecord) => `${r.date.getTime()}|${r.workoutNum}`;
  const ordered = [...rows].sort((a, b) => a.date.getTime() - b.date.getTime() || a.workoutNum - b.workoutNum);
  const groups = [...new Set(ordered.map(groupOf))];
  await ensureNonCycleRow(repos, ordered[0]?.date ?? new Date());
  const next = await nextNonCycleWorkoutNum(repos);
  const numbers = new Map(groups.map((g, i) => [g, next + i]));
  return rows.map((r) => ({
    ...r,
    program: NON_CYCLE_PROGRAM,
    macrocycleNum: NON_CYCLE_MACROCYCLE_NUM,
    workoutNum: numbers.get(groupOf(r)) ?? next,
  }));
}

const liftRecordsHandler: ImportHandler<LiftRecord> = {
  parse: parseLiftRecords,
  // Never actually called: ImportController.resolveCommitRows special-cases 'lift-records' to
  // validate against a custom-lift-aware slot map (effectiveSlotMapFor) instead of
  // calling this closure (#911) — a bare DEFAULT_SLOT_MAP here would silently stop
  // recognizing a user's custom lifts. Throws rather than falling back to the wrong
  // slot map, so a future refactor that accidentally drops that special-case (e.g.
  // "simplifying" commit() to call handler.validate uniformly) fails loudly in tests
  // instead of silently regressing custom-lift recognition.
  validate: (): never => {
    throw new Error(
      "liftRecordsHandler.validate must not be called directly for 'lift-records' — " +
        'ImportController.resolveCommitRows validates this destination against a custom-lift-aware ' +
        'slot map via effectiveSlotMapFor instead (see effective-slot-map.util.ts, issue #911).',
    );
  },
  async preview(valid, program, repos) {
    const records = valid.map((r) => withImportProgram(r, program));
    return buildLiftRecordsPreview(records, await repos.liftRecord.findStoredSets(records));
  },
  async commit(valid, program, repos) {
    // No page write runs while a file's numbers are written (proposal decision 13).
    await lockForImport(repos);
    // Row numbers below are batch-relative — 1-based within *this* commit
    // batch, i.e. after any Phase 3 excludeKeys/splitDest filtering the
    // controller already applied. For a plain commit (neither) that matches
    // the original CSV data-row number; positions shift when rows were
    // excluded or split to a second destination ahead of this call. See
    // ImportCommitResponse.skippedDetail (issue #891) for the full contract.
    const { classified, toCreate, nonCycle, created, legacyNums } = await writeFileNumberRows(
      repos,
      program,
      valid.map((r) => withImportProgram(r, program)),
    );
    const liftNames = await liftNamesFor(repos);
    // `skipped` is derived from `created` (the DB's actual insert count), not
    // `toCreate.length` (what JS classification expected to write): a
    // concurrent import racing between findStoredSets and
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
      skippedDetail: buildSkippedDetail(classified, (r) => liftRecordLabel(r, liftNames)),
      preImage: {
        ...buildLiftRecordsPreImage(toCreate),
        ...legacyRowsPreImage(legacyNums),
        ...nonCycleRowsPreImage(nonCycle),
      },
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
    return buildTrainingMaxPreview(valid, existing, await liftNamesFor(repos));
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
    return buildStrengthGoalPreview(valid, existing, await liftNamesFor(repos));
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
