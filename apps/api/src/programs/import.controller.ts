import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Get,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  GoogleSheetTab,
  GoogleSheetWorkbookResponse,
  IMPORT_ERROR_FIELD_LIFT,
  ImportAssignResponse,
  ImportClassification,
  ImportCommitResponse,
  ImportDryRunResponse,
  ImportBatchSummary,
  ImportBreakdown,
  ImportError,
  ImportKind,
  ImportPreview,
  ImportPreviewResponse,
  ImportSuggestionsResponse,
  ImportUndoResponse,
  ImportWriteResult,
  NON_CYCLE_PROGRAM,
} from '@lifting-logbook/types';
import {
  BUILT_IN_KNOWN_PROGRAMS,
  KnownProgram,
  buildSkippedDetail,
  liftRecordLabel,
  LiftRecord,
  LiftingProgramSpec,
  TrainingMax,
  StrengthGoalEntry,
  classifyImport,
  fuzzyColumnMapper,
  parseCsvText,
  parseGoogleSheetUrl,
  stringifyCsv,
  applyColumnOverrides,
  splitLiftRecordsByDestination,
  validateLiftImportSoft,
  validateLiftImport,
  validateTrainingMaxImport,
  validateStrengthGoalImport,
  buildLiftRecordsPreviewSoft,
  buildTrainingMaxPreview,
  buildTrainingMaxPreImage,
  type PreImageEntry,
  type StrengthGoalSpellingCollision,
  type TrainingMaxSpellingCollision,
  liftRecordNaturalKey,
  programSpecNaturalKey,
  withImportProgram,
  parseLiftRecords,
  segmentLiftHistory,
  fileMacrocycleKeys,
  toLiftHistoryRecord,
  isLiftRecordExport,
} from '@lifting-logbook/core';
import type { LiftImportOptions, SpreadsheetCell } from '@lifting-logbook/core';
import { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { RepositoryBundle, IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { BatchMacrocycles, createdNumberedKeys, preImageKeyNumber } from '../ports/IImportBatchRepository';
import { MacrocycleRow } from '../ports/IMacrocycleRepository';
import { RlsTxTimeout, SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { PrismaService } from '../adapters/prisma/prisma.service';
import { IMPORT_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';
import { ImportSuggestionsService } from '../import-suggestions/import-suggestions.service';
import { MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, readImportForm } from './import-file.util';
import { CustomProgramsRepository } from '../custom-programs/custom-programs.repository';
import { IMPORT_HANDLERS, liftsOf } from './import-handlers';
import {
  assignImportDate,
  assignProgramOptions,
  assignResponse,
  importAssignEnabled,
  planSplitMaxes,
  splitMaxCounts,
} from './import-assign';
import { placeSuggestedStretches, recomputeMacrocycles, releaseStatusChoices } from './import-stored';
import {
  BreakdownBatch,
  BreakdownMismatchException,
  PlacedBreakdown,
  parseBreakdown,
  placeBreakdown,
  planBreakdown,
  programCovering,
  writeBreakdown,
} from './import-breakdown';
import {
  lockForAssignedImport,
  lockForImport,
  removeEmptyLegacyRows,
  splitLegacyRowKeys,
  splitNonCycleKeys,
} from './macrocycle-history.util';
import { renumberProgram } from './macrocycle-renumbering';
import { liftNamesFor, effectiveSlotMapFor } from './effective-slot-map.util';
import { GoogleSheetImportDto } from './google-sheet-import.dto';
import {
  GoogleSheetFetchError,
  downloadGoogleSheetXlsx,
} from '../adapters/google-sheets/google-sheet-export.client';
import {
  MAX_TABLE_COLUMNS,
  WorkbookTable,
  XlsxReadError,
  xlsxToTables,
} from '../adapters/google-sheets/xlsx-to-tables';

/**
 * Unified Smart Import endpoint (#477, #615).
 *
 * `mode=preview` classifies the file and returns a per-kind before→after preview
 * without writing. `mode=commit` re-parses the uploaded file server-side and writes
 * idempotently. `mode=dry-run` takes the commit's inputs and reports the counts that
 * commit would return, also without writing (#1123). Phase 3 adds column overrides,
 * row exclusion, lift remapping for ambiguous rows, 1RM split routing, and undo.
 */
@Controller('programs/:program')
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    // Custom programs are Prisma-only, so with no database there are none (see SwitchProgramController).
    @Inject(PrismaService) private readonly prisma: PrismaService | null,
    private readonly suggestions: ImportSuggestionsService,
  ) {}

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RlsTxTimeout(IMPORT_TX_TIMEOUT_MS)
  async import(
    @Param('program') program: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthUser,
    @Query('mode') mode = 'preview',
    @Query('destination') destinationParam?: string,
    @Query('overrides') overridesParam?: string,
    @Query('excludeKeys') legacyExcludeKeys?: string,
    @Query('liftOverrides') legacyLiftOverrides?: string,
    @Query('splitDest') splitDestParam?: string,
  ): Promise<ImportPreviewResponse | ImportCommitResponse | ImportDryRunResponse | ImportAssignResponse> {
    const { csvText, fields } = await readImportForm(req);
    const assignEnabled = importAssignEnabled();
    let table = parseCsvText(csvText);

    const override = destinationParam && (Object.keys(IMPORT_HANDLERS) as ImportKind[]).includes(
      destinationParam as ImportKind,
    ) ? (destinationParam as ImportKind) : null;

    const columnOverrides = parseJsonParam<Record<string, string>>(overridesParam);

    if (mode === 'assign') {
      // With the flag off the Assign step doesn't exist (proposal Rollout step 2).
      if (!assignEnabled) throw new NotFoundException();
      if (override !== 'lift-records') {
        throw new BadRequestException('mode=assign groups lift records: send destination=lift-records');
      }
      if (columnOverrides) table = applyColumnOverrides(table, columnOverrides, override);
      const repos = await this.factory.forUser(user);
      return this.assign(program, table, repos, user.id, {
        excludeKeys: parseExcludeKeys(fields.get('excludeKeys')),
        liftOverrides: parseLiftOverrides(fields.get('liftOverrides')),
        splitDest: splitDestParam === '1',
        today: fields.get('today'),
      });
    }

    if (mode === 'commit' || mode === 'dry-run') {
      if (!override) {
        throw new BadRequestException('A valid `destination` is required to commit');
      }
      // These moved to the request body (#1121). A tab opened before that still sends
      // them in the URL, and ignoring its exclusions would commit the excluded rows.
      if (legacyExcludeKeys !== undefined || legacyLiftOverrides !== undefined) {
        throw new BadRequestException({
          message: 'Stale client',
          errors: [
            {
              row: 0,
              code: 'UNEXPECTED_ERROR',
              message: 'This page is out of date. Reload it and try the import again.',
            },
          ],
        });
      }
      if (columnOverrides) {
        table = applyColumnOverrides(table, columnOverrides, override);
      }
      const excludeKeys = parseExcludeKeys(fields.get('excludeKeys'));
      const liftOverrides = parseLiftOverrides(fields.get('liftOverrides'));
      // With the Assign step on, an export isn't split: its sets are sets, whatever their notes
      // say (decision 22), as `mode=assign` and the preview already treat it.
      const exported = assignEnabled && override === 'lift-records' && isLiftRecordExport(table[0] ?? []);
      const splitDest = splitDestParam === '1' && !exported;
      const repos = await this.factory.forUser(user);
      const breakdown = parseBreakdown(fields.get('breakdown'));
      if (breakdown) {
        if (!assignEnabled) throw new BadRequestException('A breakdown needs the Assign step, which is off');
        if (override !== 'lift-records') {
          throw new BadRequestException('A breakdown groups lift records: send destination=lift-records');
        }
        return this.importBreakdown(mode, program, table, repos, user.id, {
          breakdown,
          excludeKeys,
          liftOverrides,
          splitDest,
          exported,
          importDate: assignImportDate(fields.get('today')),
        });
      }
      // With the flag on, read blank numbers as the preview does, so the strict validator
      // rejects them rather than storing `Number('')`'s 0 that Review never showed (#1253).
      const rows = await this.resolveCommitRows(override, table, repos, excludeKeys, liftOverrides, splitDest, {
        readBlanks: assignEnabled,
      });
      return mode === 'commit'
        ? this.commit(program, override, rows, repos, user.id)
        : this.dryRun(program, override, rows, repos);
    }

    // Preview path
    const classification = classifyImport(table);
    const destination = override ?? classification.type;
    if (!destination) {
      return { classification, destination: null, columnMappings: null, preview: null, errors: [], assignEnabled };
    }

    if (columnOverrides) {
      table = applyColumnOverrides(table, columnOverrides, destination);
    }

    const assign = assignEnabled && destination === 'lift-records';
    const columnMappings = fuzzyColumnMapper(table[0] ?? [], destination, { assign });
    const repos = await this.factory.forUser(user);
    // Only a strength-goal preview applies these (#1169).
    const liftOverrides = parseLiftOverrides(fields.get('liftOverrides'));

    // For lift-records, use soft validation so incomplete/ambiguous rows appear in REVIEW
    if (destination === 'lift-records') {
      return {
        ...(await this.previewLiftRecords(program, classification, destination, table, columnMappings, repos, assign)),
        assignEnabled,
      };
    }

    const { errors, preview } = await this.preview(program, destination, table, repos, liftOverrides);
    return {
      classification,
      destination,
      columnMappings,
      preview: errors.length ? null : preview,
      errors,
      assignEnabled,
    };
  }

  /**
   * The Assign step's optional LLM suggestions (#1174, proposal decisions 11 and 12). It takes the
   * same file and Review choices as `mode=assign`, plus `notes=1` when the lifter opts to send
   * their notes, and asks the configured provider about the rules' grouping. The wizard sends it
   * only after the lifter says yes, and never waits on it for the grouping itself.
   *
   * `@SkipRlsTransaction()`: no connection is held during the upload or the model call (#518,
   * #925). The service reads the file's grouping and counts the request in short transactions of
   * their own, before the call.
   */
  @Post('import/suggestions')
  @HttpCode(HttpStatus.OK)
  @SkipRlsTransaction()
  async suggest(
    @Param('program') program: string,
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthUser,
    @Query('overrides') overridesParam?: string,
    @Query('splitDest') splitDestParam?: string,
  ): Promise<ImportSuggestionsResponse> {
    // Suggestions are part of the Assign step, which doesn't exist with the flag off.
    if (!importAssignEnabled()) throw new NotFoundException();
    const { csvText, fields } = await readImportForm(req);
    let table = parseCsvText(csvText);
    const columnOverrides = parseJsonParam<Record<string, string>>(overridesParam);
    if (columnOverrides) table = applyColumnOverrides(table, columnOverrides, 'lift-records');
    const choices = {
      excludeKeys: parseExcludeKeys(fields.get('excludeKeys')),
      liftOverrides: parseLiftOverrides(fields.get('liftOverrides')),
      splitDest: splitDestParam === '1',
      today: fields.get('today'),
    };

    // The lifter left the step, so the wizard dropped the request: stop the model too.
    const left = new AbortController();
    const socket = req.raw.socket as NodeJS.EventEmitter | undefined;
    const onClose = () => left.abort();
    socket?.once?.('close', onClose);
    try {
      return await this.suggestions.suggest({
        userId: user.id,
        notes: fields.get('notes') === '1',
        signal: left.signal,
        load: async () => {
          const repos = await this.factory.forUser(user);
          const { segmented, importDate, exported, customPrograms } = await this.segmentForAssign(
            program,
            table,
            repos,
            user.id,
            choices,
          );
          return {
            segmented,
            importDate,
            exported,
            programs: assignProgramOptions(customPrograms),
            liftNames: await liftNamesFor(repos),
          };
        },
      });
    } finally {
      socket?.removeListener?.('close', onClose);
    }
  }

  /**
   * Fetches a link-shared Google Sheets workbook and classifies each tab (#1111).
   *
   * Returns importable tabs as CSV text; the wizard then sends each chosen tab
   * through the regular `POST import` preview/commit flow as a file, so column
   * mapping, review, commit and undo are identical to a CSV upload. Nothing is
   * written here. It sits under `programs/:program` with the rest of Smart Import
   * because the wizard always picks the program first, though it reads no program data.
   *
   * `@SkipRlsTransaction()`: the handler does no DB work, and without it the
   * per-request RLS transaction would hold a pooled connection for the whole
   * Google download and parse, which can outlast the transaction's own timeout.
   */
  @Post('import/google-sheet')
  @HttpCode(HttpStatus.OK)
  @SkipRlsTransaction()
  async fetchGoogleSheet(@Body() body: GoogleSheetImportDto): Promise<GoogleSheetWorkbookResponse> {
    const parsed = parseGoogleSheetUrl(body.url);
    if (!parsed.ok) throw new BadRequestException(parsed.message);

    const started = Date.now();
    let buffer: Buffer;
    try {
      buffer = await downloadGoogleSheetXlsx(parsed.spreadsheetId);
    } catch (err) {
      // downloadGoogleSheetXlsx wraps every failure in GoogleSheetFetchError.
      if (!(err instanceof GoogleSheetFetchError)) throw err;
      this.logger.warn({ code: err.code, durationMs: Date.now() - started }, 'Google Sheet fetch failed (#1111)');
      switch (err.code) {
        case 'not-shared':
          throw new UnprocessableEntityException(err.message);
        case 'not-found':
          throw new NotFoundException(err.message);
        case 'too-large':
          throw new PayloadTooLargeException(err.message);
        default:
          throw new BadGatewayException(err.message);
      }
    }

    const parseStarted = Date.now();
    let tables: WorkbookTable[];
    try {
      // +1 for the header row.
      tables = xlsxToTables(buffer, { maxRows: MAX_IMPORT_ROWS + 1 });
    } catch (err) {
      if (!(err instanceof XlsxReadError)) throw err;
      this.logger.warn({ code: err.code, bytes: buffer.length }, 'Google Sheet workbook could not be read (#1111)');
      if (err.code === 'too-large') throw new PayloadTooLargeException(err.message);
      throw new BadGatewayException('Google Sheets returned a workbook that could not be read.');
    }
    const parseMs = Date.now() - parseStarted;

    const tabs = tables.map(({ name, rows, overflow }): GoogleSheetTab => {
      const classification = classifyImport(rows);
      const suggestedKind = suggestedKindFor(classification);
      const tab = { name, rowCount: rows.length, classification, suggestedKind };
      if (overflow === 'rows') {
        return { ...tab, csv: null, skipReason: `More than ${MAX_IMPORT_ROWS} rows, the per-import limit.` };
      }
      if (overflow === 'columns') {
        return { ...tab, csv: null, skipReason: `Has data past column ${MAX_TABLE_COLUMNS}, too wide to import.` };
      }
      if (rows.length < 2) {
        return { ...tab, csv: null, skipReason: 'Has no data rows.' };
      }
      if (suggestedKind === null) {
        return { ...tab, csv: null, skipReason: 'Not recognized as lift history, training maxes, strength goals or a program.' };
      }
      const csv = stringifyCsv(rows);
      // The tab is later uploaded as a file, which the multipart limit would reject.
      if (Buffer.byteLength(csv) > MAX_IMPORT_FILE_BYTES) {
        return { ...tab, csv: null, skipReason: 'Larger than the 5 MB import file limit.' };
      }
      return { ...tab, csv, skipReason: null };
    });

    // Counts and detected kinds only — tab names and cell contents are user data.
    this.logger.log(
      {
        bytes: buffer.length,
        tabCount: tabs.length,
        importableKinds: tabs.filter((t) => t.csv !== null).map((t) => t.suggestedKind),
        // Importable tabs offered on a best guess rather than an auto-accepted classification.
        bestGuessTabs: tabs.filter((t) => t.csv !== null && t.classification.type === null).length,
        parseMs,
        durationMs: Date.now() - started,
      },
      'Google Sheet workbook fetched (#1111)',
    );
    return { tabs };
  }

  /**
   * The lifter's lift-records imports that touched this program's past macrocycles, newest first,
   * so an import can be undone from the past-macrocycles list once the wizard is gone (#1257). One
   * through the Assign step that wrote to several programs is named by its Source program's batch,
   * which undoes it as a whole.
   */
  @Get('import/batches')
  async listImportBatches(
    @Param('program') program: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportBatchSummary[]> {
    const repos = await this.factory.forUser(user);
    const [batches, rows] = await Promise.all([
      repos.importBatch.listSummaries(program, 'lift-records'),
      repos.macrocycle.list(program),
    ]);
    return batches.flatMap((batch) => {
      const nums = touchedMacrocycleNums(batch.createdNums, batch.macrocycles, rows);
      // The rows undo can remove or read again: a `live` macrocycle keeps what it holds.
      const macrocycleIds = rows
        .filter((m) => (m.origin === 'imported' || m.origin === 'legacy') && nums.has(m.macrocycleNum))
        .map((m) => m.id);
      if (macrocycleIds.length === 0) return [];
      // A Source batch that's gone leaves its part to be undone on its own, as undo does.
      const source = batch.source ?? batch;
      return [{ id: source.id, program: source.program, createdAt: source.createdAt.toISOString(), macrocycleIds }];
    });
  }

  @Post('import/:batchId/undo')
  @HttpCode(HttpStatus.OK)
  @RlsTxTimeout(IMPORT_TX_TIMEOUT_MS)
  async undoImport(
    @Param('program') program: string,
    @Param('batchId') batchId: string,
    @CurrentUser() user: AuthUser,
    // The lifter's day, as the commit takes it, for the statuses undo reads again (#1255).
    @Query('today') today?: string,
  ): Promise<ImportUndoResponse> {
    const started = Date.now();
    const repos = await this.factory.forUser(user);
    const batch = await repos.importBatch.findById(batchId, user.id);
    if (!batch || batch.program !== program) {
      throw new NotFoundException(`Import batch ${batchId} not found`);
    }
    // A grouped batch is undone with its Source batch. One whose Source batch is gone (undone by
    // an API from before #1254, which knew no groups) is undone on its own.
    if (batch.groupId && (await repos.importBatch.findById(batch.groupId, user.id))) {
      throw new BadRequestException(`Import batch ${batchId} is part of import ${batch.groupId}. Undo that one.`);
    }

    let restored = 0;
    let skipped = 0;
    const flagged: Array<{ key: string; reason: string }> = [];

    const undoTrainingMaxes = async (entries: Array<[string, PreImageEntry]>, maxesProgram = program) => {
      if (entries.length === 0) return;
      // One read for every entry, rather than one per key.
      const allMaxes = await repos.trainingMax.getTrainingMaxes(maxesProgram);
      for (const [lift, entry] of entries) {
        const reason = await this.undoTrainingMax(repos, maxesProgram, allMaxes, lift, entry);
        if (reason === null) {
          restored++;
        } else {
          skipped++;
          flagged.push({ key: lift, reason });
        }
      }
    };

    // Hoist destination-specific reads before the loop to avoid N+1 per-key round-trips
    const allGoals = batch.destination === 'strength-goals'
      ? await repos.strengthGoal.getGoals(program)
      : [];

    if (batch.destination === 'lift-records') {
      const asOf = assignImportDate(today);
      // The undo removes macrocycle rows, so it holds the lock exclusively, as the import did.
      await lockForImport(repos, 'undo');
      // Read again under the lock: an undo of the same import that held it first has deleted the
      // batch, and its keys predate that undo's renumbering (#1257).
      const current = await repos.importBatch.findById(batchId, user.id);
      if (!current) throw new NotFoundException(`Import batch ${batchId} not found`);
      const deleteCreated = async (from: string, keys: string[]) => {
        if (keys.length === 0) return;
        const deleted = await repos.liftRecord.deleteLiftRecordsByNaturalKeys(from, keys);
        restored += deleted;
        if (deleted < keys.length) {
          const missing = keys.length - deleted;
          skipped += missing;
          flagged.push({ key: '*', reason: `${missing} row(s) not found (already deleted?)` });
        }
      };
      // An import through the Assign step saved one batch per program it wrote to, grouped under
      // this one (#1254). Each one's keys are read under its own program.
      const parts = [current, ...(await repos.importBatch.listGroup(current.id))];
      // Every part's rows go, and its emptied macrocycles with them, before any macrocycle left is
      // read again: what follows a macrocycle can be one another part is about to remove (#1255).
      const touched: Array<{ program: string; nums: number[]; ids: string[] }> = [];
      for (const part of parts) {
        // A 1RM split's training maxes share this batch, keyed by lift id (#1148). Every set and
        // `legacy` row key starts with a macrocycle number, and a lift id (a kebab-case name or a
        // custom lift's UUID) never does.
        // A non-cycle set's key, `non-cycle:<natural key>`, holds no number either, so it's
        // split off first: it's neither a training max nor a set of `program` (#1184).
        const { nonCycleKeys, otherKeys } = splitNonCycleKeys(Object.keys(part.preImage));
        const kept = new Set(otherKeys);
        const entries = Object.entries(part.preImage).filter(([k]) => kept.has(k));
        await undoTrainingMaxes(
          entries.filter(([k]) => preImageKeyNumber(k) === null),
          part.program,
        );
        // Collect all created keys and delete in a single query to avoid N+1 round-trips
        const created = createdNumberedKeys(part.preImage);
        const { setKeys: createdKeys } = splitLegacyRowKeys(created);
        // Read by number before anything is renumbered.
        const rows = await repos.macrocycle.list(part.program);
        const nums = touchedMacrocycleNums(created.flatMap((k) => preImageKeyNumber(k) ?? []), part.macrocycles, rows);
        // Only `imported` macrocycles are read again: a `live` or `legacy` row keeps what it holds.
        const ids = new Set(rows.filter((m) => m.origin === 'imported' && nums.has(m.macrocycleNum)).map((m) => m.id));
        // The statuses the batch chose are released before anything is read again.
        await releaseStatusChoices(repos, part, part.macrocycles?.chosen ?? [], new Map(rows.map((m) => [m.id, m])));
        await deleteCreated(part.program, createdKeys);
        // The non-cycle macrocycle's row stays, as it does when its workouts are deleted.
        await deleteCreated(NON_CYCLE_PROGRAM, nonCycleKeys);
        // The batch goes first, so the renumbering below doesn't rewrite the keys of a batch about
        // to be deleted.
        await repos.importBatch.deleteById(part.id, user.id);
        touched.push({ program: part.program, nums: [...nums], ids: [...ids] });
      }
      // A `legacy` or `imported` macrocycle left with no sets goes (ADR-042): one the import
      // created, or one its sets joined.
      let removed = 0;
      for (const { program: p, nums } of touched) removed += await removeEmptyLegacyRows(repos, p, nums);
      // The `imported` macrocycles left are recomputed from the sets on them, which a later import
      // may have added to, rather than restored (#1255, decision 14).
      const ids = touched.flatMap((t) => t.ids);
      const recomputed = ids.length > 0
        ? await recomputeMacrocycles(
            repos,
            ids,
            [...BUILT_IN_KNOWN_PROGRAMS, ...(await this.customPrograms(user.id))],
            asOf,
          )
        : 0;
      // And the numbers close up.
      for (const { program: p } of touched) await renumberProgram(repos, p);
      // Counts only: dates and statuses are the lifter's data.
      this.logger.log(
        { parts: parts.length, macrocyclesRecomputed: recomputed, macrocyclesRemoved: removed, durationMs: Date.now() - started },
        'Import undo recomputed its macrocycles (#1255)',
      );
    } else if (batch.destination === 'training-maxes') {
      await undoTrainingMaxes(Object.entries(batch.preImage));
      await repos.importBatch.deleteById(batchId, user.id);
    } else {
      for (const [key, entry] of Object.entries(batch.preImage)) {
        if (batch.destination === 'strength-goals') {
          const lift = key;
          const current = allGoals.find((g) => g.lift === lift);
          const wrote = entry.wrote as Record<string, unknown>;

          if (!current) {
            skipped++;
            flagged.push({ key, reason: 'strength goal no longer exists' });
            continue;
          }
          if (
            current.goalType !== wrote['goalType'] ||
            current.target !== wrote['target'] ||
            current.unit !== wrote['unit'] ||
            current.ratio !== wrote['ratio']
          ) {
            skipped++;
            flagged.push({ key, reason: 'goal modified after import' });
            continue;
          }

          if (entry.kind === 'created') {
            await repos.strengthGoal.deleteGoal(program, lift);
            restored++;
          } else if (entry.kind === 'updated') {
            const before = entry.before as Record<string, unknown>;
            const goalTarget = before['target'];
            const goalRatio = before['ratio'];
            await repos.strengthGoal.upsertGoal(program, {
              lift,
              goalType: before['goalType'] as 'absolute' | 'relative',
              ...(goalTarget !== undefined ? { target: goalTarget as number } : {}),
              unit: before['unit'] as 'lbs' | 'kg',
              ...(goalRatio !== undefined ? { ratio: goalRatio as number } : {}),
              updatedAt: new Date(),
            });
            restored++;
          }
        } else if (batch.destination === 'program-spec') {
          if (entry.kind === 'created') {
            await repos.liftingProgramSpec.deleteSpecRows(program, [key]);
            restored++;
          } else {
            // Program-spec `updated` rows cannot be auto-undone: `comparable` captures
            // only the serialized mutable fields, not the full prior row shape needed to
            // reconstruct the previous spec. Flag so the caller knows undo was partial.
            flagged.push({ key, reason: 'program-spec row updates cannot be undone automatically' });
            skipped++;
          }
        }
      }
      // Delete the batch record now that undo has been applied (best-effort; ignore failures)
      await repos.importBatch.deleteById(batchId, user.id);
    }

    return { batchId, restored, skipped, flagged };
  }

  /**
   * Reverses one training max an import wrote: deletes a created one, or restores an updated
   * one's prior weight. Returns why it was skipped, or null once undone.
   */
  private async undoTrainingMax(
    repos: RepositoryBundle,
    program: string,
    allMaxes: TrainingMax[],
    lift: string,
    entry: PreImageEntry,
  ): Promise<string | null> {
    const current = allMaxes.find((m) => m.lift === lift);
    const wrote = entry.wrote as { weight: number };
    if (!current) return 'training max no longer exists';
    if (current.weight !== wrote.weight) {
      return `weight modified after import (expected ${wrote.weight}, found ${current.weight})`;
    }
    if (entry.kind === 'created') {
      await repos.trainingMax.deleteTrainingMaxes(program, [lift]);
    } else {
      const before = entry.before as { weight: number; dateUpdated: string };
      await repos.trainingMax.saveTrainingMaxes(program, [
        { lift: current.lift, weight: before.weight, dateUpdated: new Date(before.dateUpdated) },
      ]);
    }
    return null;
  }

  /** Preview for lift-records using soft validation (includes incomplete/ambiguous rows). */
  private async previewLiftRecords(
    program: string,
    classification: ReturnType<typeof classifyImport>,
    destination: ImportKind,
    table: SpreadsheetCell[][],
    columnMappings: ReturnType<typeof fuzzyColumnMapper>,
    repos: RepositoryBundle,
    assign: boolean,
  ): Promise<ImportPreviewResponse> {
    let parsed: LiftRecord[];
    try {
      parsed = parseLiftRecords(table, { assign });
    } catch (err) {
      return {
        classification,
        destination,
        columnMappings,
        preview: null,
        errors: [{ row: 0, code: 'FILE_PARSE_FAILED', message: `Could not parse file: ${(err as Error).message}` }],
      };
    }
    if (parsed.length > MAX_IMPORT_ROWS) {
      return {
        classification,
        destination,
        columnMappings,
        preview: null,
        errors: [{ row: 0, code: 'ROW_LIMIT_EXCEEDED', message: `Import exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. Split the file into smaller batches.` }],
      };
    }

    // Custom lifts are folded into the slot map fresh per request (#911) so a row whose
    // raw text already matches an existing custom lift's name resolves immediately
    // instead of being flagged ambiguous.
    const softResult = validateLiftImportSoft(parsed, await effectiveSlotMapFor(repos), { assign });
    if (softResult.hardErrors.length) {
      return { classification, destination, columnMappings, preview: null, errors: softResult.hardErrors };
    }

    const validWithProgram = softResult.validRows.map(({ record }) => withImportProgram(record, program));
    const stored = await repos.liftRecord.findStoredSets(validWithProgram);
    const liftNames = await liftNamesFor(repos);
    const preview = buildLiftRecordsPreviewSoft(softResult, stored, liftNames);

    // Check for 1RM rows in the valid set. With the Assign step on, an export has none (decision 22).
    const exported = assign && isLiftRecordExport(table[0] ?? []);
    const { trainingMaxes: splitMaxes } = exported
      ? { trainingMaxes: [] }
      : splitLiftRecordsByDestination(validWithProgram);
    let split: ImportPreviewResponse['split'] | undefined;
    if (splitMaxes.length > 0) {
      const existingMaxes = await repos.trainingMax.getTrainingMaxes(program);
      split = {
        destination: 'training-maxes',
        preview: buildTrainingMaxPreview(splitMaxes, existingMaxes, liftNames),
      };
    }

    return {
      classification,
      destination,
      columnMappings,
      preview,
      errors: [],
      ...(split ? { split } : {}),
    };
  }

  /** Parse + validate for a destination, then build a before→after preview (no writes). */
  private async preview(
    program: string,
    destination: ImportKind,
    table: SpreadsheetCell[][],
    repos: RepositoryBundle,
    liftOverrides: Record<string, string>,
  ): Promise<{ errors: ImportError[]; preview: ImportPreviewResponse['preview'] }> {
    const {
      valid,
      errors,
      spellingCollisions = [],
      goalSpellingCollisions = [],
    } = await this.parseAndValidate(destination, table, repos, liftOverrides);
    if (errors.length) return { errors, preview: null };
    const handler = IMPORT_HANDLERS[destination]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
    const previewResult = await handler.preview(valid as any, program, repos);
    if (spellingCollisions.length === 0 && goalSpellingCollisions.length === 0) {
      return { errors, preview: previewResult };
    }

    const liftNames = await liftNamesFor(repos);
    const labelled = <C extends { key: string }>(collisions: C[]) =>
      collisions.map((collision) => ({ ...collision, label: liftNames.get(collision.key) ?? collision.key }));
    return {
      errors,
      preview: {
        ...previewResult,
        ...(spellingCollisions.length > 0 ? { spellingCollisions: labelled(spellingCollisions) } : {}),
        ...(goalSpellingCollisions.length > 0 ? { goalSpellingCollisions: labelled(goalSpellingCollisions) } : {}),
      },
    };
  }

  /**
   * Re-parses the file and applies the user's choices, giving the rows a commit writes
   * (400 on validation errors). The commit and the dry run both start here, so the dry
   * run's counts describe the same rows (#1123). So does `mode=assign` (#1253), with
   * `assign`: a lift-records file needn't number its macrocycles or workouts, and its rows
   * with a blank date are left out and counted in `undated`. `readBlanks` parses blank
   * numbers as `assign` does but still validates strictly, so a blank is an error, not 0.
   */
  private async resolveCommitRows(
    destination: ImportKind,
    table: SpreadsheetCell[][],
    repos: RepositoryBundle,
    excludeKeys: Set<string>,
    liftOverrides: Record<string, string>,
    splitDest: boolean,
    options: LiftImportOptions & { readBlanks?: boolean } = {},
  ): Promise<CommitRows> {
    // Parse before any transforms: liftOverrides must remap before strict validation
    // because the strict validator rejects unknown-lift rows outright.
    const handler = IMPORT_HANDLERS[destination]!;
    const assign = options.assign === true && destination === 'lift-records';
    const readBlanks = (assign || options.readBlanks === true) && destination === 'lift-records';
    let parsed: unknown[];
    try {
      parsed = readBlanks ? parseLiftRecords(table, { assign: true }) : handler.parse(table);
    } catch (err) {
      throw new BadRequestException({ message: `Could not parse file: ${(err as Error).message}` });
    }
    if (parsed.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        message: `Import exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. Split the file into smaller batches.`,
      });
    }

    // Apply lift overrides BEFORE strict validation so remapped names pass the slot map check.
    // Must run before the row exclusion filter below: both key off
    // the row's position in `parsed` as originally parsed (1-based), and
    // .filter() (unlike this .map()) changes array length/indices — reversing
    // the order would silently apply row N's override to whatever shifted
    // into row N's old position after an earlier row was removed.
    if (destination === 'lift-records' || destination === 'strength-goals') {
      parsed = withLiftOverrides(parsed as (LiftRecord | StrengthGoalEntry)[], liftOverrides);
    }
    if (destination === 'strength-goals') {
      const overrideErrors = await unrecognizedGoalOverrides(liftOverrides, repos);
      if (overrideErrors.length > 0) {
        throw new BadRequestException({ message: 'Validation failed', errors: overrideErrors });
      }
    }

    // A tab opened before #1123 sends an ambiguous OR incomplete lift-records
    // row's excludeKeys entry as `__ambiguous_<rowIndex>` / `__incomplete_<rowIndex>`
    // (buildImportPreview.ts) — never a natural key, so the
    // natural-key excludeKeys filter further below can't match either
    // (issue #915, fully resolved here — both statuses share the identical
    // failure mode: no other in-wizard repair path, and an excluded row that
    // still reached strict validation used to fail the WHOLE commit).
    //
    // `__row_<rowIndex>` is what the wizard sends now, for any row: two rows can
    // share a natural key, and excluding one must leave the other (#1123). It
    // applies to every destination whose preview gives its rows a rowIndex.
    //
    // Filtering also shortens `parsed`, which would otherwise mis-number
    // every subsequent row's validation-error `row` field —
    // validateLiftImport's row numbers are purely positional. `survivingRowOriginalIndexes`
    // records each kept row's original 1-based position before filtering;
    // errors are remapped back to it after validation runs, so a failed
    // commit still points at the right CSV line.
    let survivingRowOriginalIndexes: number[] | null = null;
    if (excludeKeys.size > 0) {
      const excludedRowIndexes = new Set(
        [...excludeKeys]
          .map((k) => /^__(?:ambiguous|incomplete|row)_(\d+)$/.exec(k)?.[1])
          .filter((s): s is string => s !== undefined)
          .map(Number),
      );
      if (excludedRowIndexes.size > 0) {
        const kept: unknown[] = [];
        const originalIndexes: number[] = [];
        parsed.forEach((r, i) => {
          const originalRowIndex = i + 1;
          if (excludedRowIndexes.has(originalRowIndex)) return;
          kept.push(r);
          originalIndexes.push(originalRowIndex);
        });
        parsed = kept;
        survivingRowOriginalIndexes = originalIndexes;
      }
    }

    // Strict validation (with overrides applied). Lift-records, training-maxes, and
    // strength-goals each get a custom-lift-aware slot map built fresh per request
    // (#911, extended to the latter two by #914), special-cased here rather than
    // threading extra context through the generic ImportHandler.validate signature —
    // matching this method's other per-destination special cases below (excludeKeys
    // filtering, splitDest partitioning). liftRecordsHandler.validate /
    // trainingMaxesHandler.validate / strengthGoalsHandler.validate (import-handlers.ts)
    // are unreachable for their destinations as a result, but stay in place (throwing
    // unconditionally) to satisfy the ImportHandler<T> interface program-spec still uses.
    let rawValid: unknown[];
    let errors: ImportError[];
    let undated = 0;
    if (destination === 'lift-records') {
      const result = validateLiftImport(parsed as LiftRecord[], await effectiveSlotMapFor(repos), { assign });
      ({ valid: rawValid, errors } = result);
      undated = result.undated.length;
    } else if (destination === 'training-maxes') {
      ({ valid: rawValid, errors } = validateTrainingMaxImport(parsed as TrainingMax[], await effectiveSlotMapFor(repos)));
    } else if (destination === 'strength-goals') {
      ({ valid: rawValid, errors } = validateStrengthGoalImport(parsed as StrengthGoalEntry[], await effectiveSlotMapFor(repos)));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
      ({ valid: rawValid, errors } = handler.validate(parsed as any));
    }
    if (errors.length > 0) {
      const originalIndexes = survivingRowOriginalIndexes;
      throw new BadRequestException({
        message: 'Validation failed',
        errors: originalIndexes
          ? errors.map((e) => ({ ...e, row: originalIndexes[e.row - 1] ?? e.row }))
          : errors,
      });
    }
    let valid: unknown[] = rawValid;

    // Filter excluded keys. Only a tab opened before #1123 still sends these.
    if (excludeKeys.size > 0) {
      if (destination === 'lift-records') {
        valid = (valid as LiftRecord[]).filter((r) => !excludeKeys.has(liftRecordNaturalKey(r)));
      } else if (destination === 'program-spec') {
        valid = (valid as LiftingProgramSpec[]).filter((r) => !excludeKeys.has(programSpecNaturalKey(r)));
      } else {
        // Training-max and strength-goal delta keys are the lift name.
        valid = (valid as (TrainingMax | StrengthGoalEntry)[]).filter((r) => !excludeKeys.has(r.lift));
      }
    }

    // For splitDest, partition before committing to avoid double-writing 1RM rows as lift-records
    if (destination === 'lift-records' && splitDest) {
      const { liftRecords, trainingMaxes } = splitLiftRecordsByDestination(valid as LiftRecord[]);
      return { rows: liftRecords, splitMaxes: trainingMaxes, undated };
    }
    return { rows: valid, splitMaxes: [], undated };
  }

  /**
   * `mode=assign` (#1253): the rules' grouping of the file into suggested macrocycles, after
   * Review's lift overrides and exclusions (proposal decision 16). Its rows are the commit's
   * (`resolveCommitRows` with `assign`). Nothing is written.
   */
  private async assign(
    program: string,
    table: SpreadsheetCell[][],
    repos: RepositoryBundle,
    userId: string,
    choices: { excludeKeys: Set<string>; liftOverrides: Record<string, string>; splitDest: boolean; today: string | undefined },
  ): Promise<ImportAssignResponse> {
    const started = Date.now();
    const { importDate, exported, split, liftRecords, splitMaxes, undated, customPrograms, segmented } =
      await this.segmentForAssign(program, table, repos, userId, choices);
    const stored = await placeSuggestedStretches(repos, segmented.stretches, [
      ...BUILT_IN_KNOWN_PROGRAMS,
      ...customPrograms,
    ]);
    const response = assignResponse(
      segmented,
      {
        importDate,
        undatedRows: undated,
        exported,
        programs: assignProgramOptions(customPrograms),
        stored,
        ...(split ? { split: await splitMaxCounts(splitMaxes, segmented.stretches, program, repos) } : {}),
        suggestionsProvider: this.suggestions.providerLabel,
      },
      await liftNamesFor(repos),
    );

    // Counts only: rows, lift names and notes are the lifter's data (proposal Observability).
    this.logger.log(
      {
        keptRows: liftRecords.length + splitMaxes.length + undated,
        sessions: response.sessions,
        stretches: response.stretches.length,
        unmatchedStretches: response.stretches.filter((s) => !s.matched).length,
        loneSessions: response.lone.length,
        nonCycleSessions: response.nonCycle.length,
        unnumberedSessions: response.unnumbered.length,
        conflicts: response.conflicts.length,
        joiningStretches: stored.filter((s) => s.kind === 'joins').length,
        alreadyImportedStretches: stored.filter((s) => s.kind === 'already-imported').length,
        overlappingStretches: stored.filter((s) => s.kind === 'overlaps').length,
        undatedRows: response.undatedRows,
        exported,
        splitChanges: response.split?.changes ?? 0,
        splitOlderThanCurrent: response.split?.olderThanCurrent ?? 0,
        durationMs: Date.now() - started,
      },
      'Import assign (#1253)',
    );
    return response;
  }

  /**
   * The file as Assign reads it (#1253): its rows after Review's edits, and the rules' grouping of
   * them. `mode=assign` and the suggestion request (#1174) both start here, so the model is asked
   * about exactly the grouping the lifter sees.
   */
  private async segmentForAssign(
    program: string,
    table: SpreadsheetCell[][],
    repos: RepositoryBundle,
    userId: string,
    choices: { excludeKeys: Set<string>; liftOverrides: Record<string, string>; splitDest: boolean; today: string | undefined },
  ) {
    const importDate = assignImportDate(choices.today);
    // An export isn't split: its sets are sets, whatever their notes say (decision 22).
    const exported = isLiftRecordExport(table[0] ?? []);
    const split = choices.splitDest && !exported;
    const { rows, splitMaxes, undated } = await this.resolveCommitRows(
      'lift-records',
      table,
      repos,
      choices.excludeKeys,
      choices.liftOverrides,
      split,
      { assign: true },
    );
    const liftRecords = rows as LiftRecord[];
    const customPrograms = await this.customPrograms(userId);
    const segmented = segmentLiftHistory(liftRecords.map(toLiftHistoryRecord), {
      importDate,
      sourceProgram: program,
      customPrograms,
      // An export pairs rows by file macrocycle; the commit places any other file by date.
      placeByDate: !exported,
    });
    return { importDate, exported, split, liftRecords, splitMaxes, undated, customPrograms, segmented };
  }

  /** The lifter's custom programs. They're Prisma-only, so with no database there are none. */
  private async customPrograms(userId: string): Promise<KnownProgram[]> {
    return this.prisma ? new CustomProgramsRepository(this.prisma.clientForRequest(), userId).listKnownPrograms() : [];
  }

  /**
   * `mode=dry-run` and `mode=commit` with the lifter's confirmed Assign breakdown (#1254,
   * proposal decision 17). The file is re-parsed with Review's edits, as `mode=assign` reads it,
   * and the breakdown is checked against it before anything is written (400
   * `breakdown-mismatch`). Each stretch with a new row becomes an `imported` macrocycle under its
   * program, rows already stored are skipped (decision 13), and split rows go to the program of
   * the stretch covering their date (decision 10). The commit saves one batch per program, the
   * Source program's first with the others grouped under it, and a failed save fails the whole
   * request, so its transaction writes nothing.
   */
  private async importBreakdown(
    mode: 'commit' | 'dry-run',
    program: string,
    table: SpreadsheetCell[][],
    repos: RepositoryBundle,
    userId: string,
    choices: {
      breakdown: ImportBreakdown;
      excludeKeys: Set<string>;
      liftOverrides: Record<string, string>;
      splitDest: boolean;
      exported: boolean;
      /** What a joined macrocycle's suggested status is judged against (#1255). */
      importDate: Date;
    },
  ): Promise<ImportCommitResponse | ImportDryRunResponse> {
    const started = Date.now();
    const { rows, splitMaxes, undated } = await this.resolveCommitRows(
      'lift-records',
      table,
      repos,
      choices.excludeKeys,
      choices.liftOverrides,
      choices.splitDest,
      { assign: true },
    );
    const customPrograms = await this.customPrograms(userId);
    const programs = [...BUILT_IN_KNOWN_PROGRAMS, ...customPrograms];
    let placed: PlacedBreakdown;
    try {
      const ids = new Set(programs.map((p) => p.id));
      placed = placeBreakdown(
        rows as LiftRecord[],
        choices.breakdown,
        // An export's rows pair with its macrocycles as `mode=assign` grouped them.
        choices.exported
          ? {
              exported: true,
              programs: ids,
              fileKeys: fileMacrocycleKeys((rows as LiftRecord[]).map(toLiftHistoryRecord), {
                importDate: choices.importDate,
                sourceProgram: program,
                customPrograms,
              }),
            }
          : { exported: false, programs: ids },
      );
    } catch (err) {
      // The reason only: the message names the lifter's dates and programs.
      if (err instanceof BreakdownMismatchException) {
        this.logger.warn(
          { mode, reason: err.reason, stretches: choices.breakdown.stretches.length },
          'Import breakdown mismatch (#1254)',
        );
      }
      throw err;
    }
    // A commit reads what's stored and writes under the import lock, so a second commit of the
    // same file gets a 409 rather than writing it twice (decision 13).
    if (mode === 'commit') {
      try {
        await lockForAssignedImport(repos);
      } catch (err) {
        if (err instanceof ConflictException) this.logger.warn({ mode }, 'Import breakdown refused: another import is running (#1254)');
        throw err;
      }
    }
    const plan = await planBreakdown(repos, placed, programs);
    const split = await planSplitMaxes(splitMaxes, programCovering(placed.stretches, program), repos);
    const splitRows = [...split.byProgram.values()];
    const splitWrites = splitRows.reduce((n, s) => n + s.writes.length, 0);
    const extended = plan.stretches.filter((s) => s.stored.kind === 'joins').length;
    const assigned = {
      macrocycles: plan.stretches.length - extended,
      extended,
      nonCycleSessions: placed.nonCycleSessions,
      excludedSessions: placed.excludedSessions,
      undatedRows: undated,
      changed: plan.changed,
      splitOlderThanCurrent: split.olderThanCurrent,
    };

    let created: number;
    let splitCounts: ImportWriteResult | null = null;
    let batchId: string | null = null;
    if (mode === 'dry-run') {
      created = plan.classified.filter((c) => c.kind === 'create').length;
      if (splitMaxes.length > 0) {
        splitCounts = sumCounts(
          splitRows.map((s) => previewCounts(buildTrainingMaxPreview(s.writes, s.existing, new Map()))),
        );
      }
    } else {
      const written = await writeBreakdown(repos, program, plan, { programs, importDate: choices.importDate });
      created = written.created;
      const batches = written.batches;
      if (splitMaxes.length > 0) {
        const results: ImportWriteResult[] = [];
        for (const [splitProgram, { existing, writes }] of split.byProgram) {
          if (writes.length === 0) continue;
          results.push(await repos.trainingMax.importTrainingMaxes(splitProgram, writes));
          const batch = batches.get(splitProgram) ?? { preImage: {}, macrocycles: { created: [], extended: [], chosen: [] } };
          Object.assign(batch.preImage, buildTrainingMaxPreImage(writes, existing));
          batches.set(splitProgram, batch);
        }
        splitCounts = sumCounts(results);
      }
      batchId = await saveBatchGroup(repos, userId, program, batches);
    }
    // A split row not written is older than its program's max or than a newer row of its lift.
    const splitResult = splitCounts && {
      destination: 'training-maxes' as const,
      ...splitCounts,
      skipped: splitCounts.skipped + splitMaxes.length - splitWrites,
    };
    const skipped = plan.classified.length - created;

    // Counts only: rows, lift names and notes are the lifter's data (proposal Observability).
    this.logger.log(
      {
        mode,
        stretches: choices.breakdown.stretches.length,
        ...assigned,
        created,
        duplicates: skipped,
        splitChanges: split.changes,
        exported: choices.exported,
        durationMs: Date.now() - started,
      },
      'Import breakdown (#1254)',
    );

    const counts = { destination: 'lift-records' as const, created, updated: 0, skipped, assigned };
    if (mode === 'dry-run') return { ...counts, ...(splitResult ? { split: splitResult } : {}) };
    const liftNames = await liftNamesFor(repos);
    return {
      ...counts,
      batchId,
      skippedDetail: buildSkippedDetail(plan.classified, ({ r }) => liftRecordLabel(r, liftNames)),
      // Created rows in this program only, as in liftRecordsHandler.commit: another program's
      // list wouldn't count the rest (#1273).
      lifts: liftsOf(plan.stretches.filter((s) => s.spec.program === program).flatMap((s) => s.creating)),
      ...(splitResult ? { split: splitResult } : {}),
    };
  }

  /** The counts {@link commit} would return for these rows, without writing them (#1123). */
  private async dryRun(
    program: string,
    destination: ImportKind,
    { rows, splitMaxes }: CommitRows,
    repos: RepositoryBundle,
  ): Promise<ImportDryRunResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
    const preview = await IMPORT_HANDLERS[destination].preview(rows as any, program, repos);
    let split: ImportDryRunResponse['split'];
    if (splitMaxes.length > 0) {
      const existingMaxes = await repos.trainingMax.getTrainingMaxes(program);
      split = {
        destination: 'training-maxes',
        // Only counts leave this method, so the labels need no lift names.
        ...previewCounts(buildTrainingMaxPreview(splitMaxes, existingMaxes, new Map())),
      };
    }
    return { destination, ...previewCounts(preview), ...(split ? { split } : {}) };
  }

  /** Writes the rows {@link resolveCommitRows} produced. */
  private async commit(
    program: string,
    destination: ImportKind,
    { rows, splitMaxes }: CommitRows,
    repos: RepositoryBundle,
    userId: string,
  ): Promise<ImportCommitResponse> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
    const { preImage, ...commitCounts } = await IMPORT_HANDLERS[destination].commit(rows as any, program, repos);

    // Phase 3: 1RM split for lift-records — commit the TM partition after lift-records
    let splitResult: ImportCommitResponse['split'] | undefined;
    if (splitMaxes.length > 0) {
      const existingMaxes = await repos.trainingMax.getTrainingMaxes(program);
      const tmResult = await repos.trainingMax.importTrainingMaxes(program, splitMaxes);
      const tmPreImage = buildTrainingMaxPreImage(splitMaxes, existingMaxes);
      Object.assign(preImage, tmPreImage);
      splitResult = { destination: 'training-maxes', ...tmResult };
    }

    // Save import batch for undo; best-effort — a save failure leaves batchId null but the
    // import data is already written and the commit response still succeeds.
    const batchId = randomUUID();
    let savedBatchId: string | null = null;
    try {
      await repos.importBatch.save({ id: batchId, userId, program, destination, preImage, createdAt: new Date() });
      savedBatchId = batchId;
    } catch {
      // Intentional: undo availability is non-critical; import commit must not fail here
    }

    return {
      destination,
      ...commitCounts,
      batchId: savedBatchId,
      ...(splitResult ? { split: splitResult } : {}),
    };
  }

  private async parseAndValidate(
    destination: ImportKind,
    table: SpreadsheetCell[][],
    repos: RepositoryBundle,
    liftOverrides: Record<string, string>,
  ): Promise<{
    valid: unknown[];
    errors: ImportError[];
    spellingCollisions?: TrainingMaxSpellingCollision[];
    goalSpellingCollisions?: StrengthGoalSpellingCollision[];
  }> {
    // lift-records must never reach here. Its only current caller — preview()
    // — branches lift-records off to previewLiftRecords before ever calling
    // this method (see the destination check immediately above this.preview's
    // call site). liftRecordsHandler.validate throws unconditionally
    // (import-handlers.ts) rather than silently falling back to a
    // non-custom-lift-aware slot map, so without this explicit guard a future
    // refactor that lost that branch would surface as that generic throw
    // message here instead of a message naming the actual broken invariant
    // (issue #911 review, third pass).
    if (destination === 'lift-records') {
      throw new Error(
        "parseAndValidate must not be called for 'lift-records' — route through previewLiftRecords instead",
      );
    }
    const handler = IMPORT_HANDLERS[destination]!;
    let parsed: unknown[];
    try {
      parsed = handler.parse(table);
    } catch (err) {
      return { valid: [], errors: [{ row: 0, code: 'FILE_PARSE_FAILED', message: `Could not parse file: ${(err as Error).message}` }] };
    }
    if (parsed.length > MAX_IMPORT_ROWS) {
      return {
        valid: [],
        errors: [{ row: 0, code: 'ROW_LIMIT_EXCEEDED', message: `Import exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. Split the file into smaller batches.` }],
      };
    }
    // Training-maxes and strength-goals get a custom-lift-aware slot map built
    // fresh per request (#914), same rationale as lift-records above: special-cased
    // here rather than threading extra context through the generic
    // ImportHandler.validate signature (trainingMaxesHandler.validate /
    // strengthGoalsHandler.validate throw unconditionally as a result — see
    // import-handlers.ts).
    if (destination === 'training-maxes') {
      return validateTrainingMaxImport(parsed as TrainingMax[], await effectiveSlotMapFor(repos));
    }
    if (destination === 'strength-goals') {
      // A kept row previews under its custom lift, as the commit will store it (#1169).
      const overrideErrors = await unrecognizedGoalOverrides(liftOverrides, repos);
      if (overrideErrors.length > 0) return { valid: [], errors: overrideErrors };
      return validateStrengthGoalImport(
        withLiftOverrides(parsed as StrengthGoalEntry[], liftOverrides),
        await effectiveSlotMapFor(repos),
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
    return handler.validate(parsed as any);
  }
}

/**
 * The numbers of `rows`, its program's macrocycles, that a lift-records batch touched: those it
 * created or extended, and `createdNums`, the numbers of its created sets and `legacy` rows
 * ({@link createdNumberedKeys}), which is all a batch from before #1255 records.
 */
function touchedMacrocycleNums(
  createdNums: readonly number[],
  macrocycles: BatchMacrocycles | null | undefined,
  rows: readonly MacrocycleRow[],
): Set<number> {
  const nums = new Set(createdNums);
  const recorded = new Set([...(macrocycles?.created ?? []), ...(macrocycles?.extended ?? [])]);
  for (const m of rows) if (recorded.has(m.id)) nums.add(m.macrocycleNum);
  return nums;
}

/** Replaces the lift of each overridden row. `liftOverrides` keys are 1-based positions in `rows`. */
function withLiftOverrides<R extends { lift: unknown }>(rows: R[], liftOverrides: Record<string, string>): R[] {
  return rows.map((r, i) => {
    const canonical = liftOverrides[String(i + 1)];
    return canonical ? { ...r, lift: canonical } : r;
  });
}

/**
 * Overrides naming no known lift. A goal row's own lift may be free text, but an override is a
 * lift the user picked, so one that's gone was deleted after the Keep. Stored, its goal would sit
 * under an id nothing resolves (#1169). `row` is the row's position before any exclusions.
 */
async function unrecognizedGoalOverrides(
  liftOverrides: Record<string, string>,
  repos: RepositoryBundle,
): Promise<ImportError[]> {
  const overrides = Object.entries(liftOverrides);
  if (overrides.length === 0) return [];
  const slotMap = await effectiveSlotMapFor(repos);
  return overrides
    .filter(([, lift]) => !Object.prototype.hasOwnProperty.call(slotMap, lift))
    .map(([row]) => ({
      row: Number(row),
      field: IMPORT_ERROR_FIELD_LIFT,
      code: 'UNRECOGNIZED_LIFT',
      message: "The custom lift chosen for this row no longer exists. Exclude the row, or go back and keep it as a new lift.",
    }));
}

/**
 * The rows a commit writes: to its destination, and 1RM rows split off to training maxes.
 * `undated`: with `assign`, how many rows were left out for a blank date (#1253).
 */
type CommitRows = { rows: unknown[]; splitMaxes: TrainingMax[]; undated: number };

function previewCounts(preview: ImportPreview): ImportWriteResult {
  return { created: preview.creates, updated: preview.updates, skipped: preview.skips };
}

function sumCounts(results: readonly ImportWriteResult[]): ImportWriteResult {
  return results.reduce(
    (sum, r) => ({ created: sum.created + r.created, updated: sum.updated + r.updated, skipped: sum.skipped + r.skipped }),
    { created: 0, updated: 0, skipped: 0 },
  );
}

/**
 * Saves an Assign import's batches (#1254): `sourceProgram`'s first, then one per other program
 * it wrote to, grouped under the first, whose id it returns. Not best-effort, unlike a file-number
 * commit's single batch: a batch is the only way to undo these rows, so a failed save fails the
 * request and its transaction writes nothing (decision 17).
 */
async function saveBatchGroup(
  repos: Pick<RepositoryBundle, 'importBatch'>,
  userId: string,
  sourceProgram: string,
  batches: ReadonlyMap<string, BreakdownBatch>,
): Promise<string> {
  const groupId = randomUUID();
  const createdAt = new Date();
  const source = batches.get(sourceProgram);
  // `writeBreakdown` always gives the Source program a batch.
  if (!source) throw new Error(`No import batch for the Source program ${sourceProgram}`);
  await repos.importBatch.save({
    id: groupId,
    userId,
    program: sourceProgram,
    destination: 'lift-records',
    preImage: source.preImage,
    createdAt,
    macrocycles: source.macrocycles,
  });
  for (const [program, { preImage, macrocycles }] of batches) {
    if (program === sourceProgram) continue;
    await repos.importBatch.save({
      id: randomUUID(),
      userId,
      program,
      destination: 'lift-records',
      preImage,
      createdAt,
      groupId,
      macrocycles,
    });
  }
  return groupId;
}

/**
 * The kind a Google Sheets tab is offered as: the classifier's pick, or for a
 * medium/high-confidence tab that missed auto-accept, its top-scoring kind (the
 * CSV path offers the same tab a manual pick). `classifyImport` lists every kind
 * except the top scorer in `alternatives`, so the top scorer is the one missing.
 */
export function suggestedKindFor(classification: ImportClassification): ImportKind | null {
  if (classification.type !== null) return classification.type;
  if (classification.bucket === 'low') return null;
  const kinds = Object.keys(IMPORT_HANDLERS) as ImportKind[];
  return kinds.find((kind) => !classification.alternatives.some((a) => a.type === kind)) ?? null;
}

function parseJsonParam<T>(param: string | undefined): T | null {
  if (!param) return null;
  try {
    return JSON.parse(param) as T;
  } catch {
    throw new BadRequestException(`Invalid JSON in query parameter: ${param}`);
  }
}

function parseExcludeKeys(field: string | undefined): Set<string> {
  if (field === undefined) return new Set();
  const parsed = parseJsonField('excludeKeys', field);
  if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === 'string')) {
    throw new BadRequestException('`excludeKeys` must be a JSON array of strings');
  }
  return new Set(parsed);
}

function parseLiftOverrides(field: string | undefined): Record<string, string> {
  if (field === undefined) return {};
  const parsed = parseJsonField('liftOverrides', field);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((lift) => typeof lift === 'string')
  ) {
    throw new BadRequestException('`liftOverrides` must be a JSON object of row index to lift');
  }
  return parsed as Record<string, string>;
}

/** The message names the field but not its value, which can run to megabytes. */
function parseJsonField(name: string, field: string): unknown {
  try {
    return JSON.parse(field);
  } catch {
    throw new BadRequestException(`Invalid JSON in form field: ${name}`);
  }
}
