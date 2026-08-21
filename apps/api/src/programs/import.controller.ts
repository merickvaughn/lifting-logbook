import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ImportCommitResponse,
  ImportError,
  ImportKind,
  ImportPreviewResponse,
  ImportUndoResponse,
} from '@lifting-logbook/types';
import {
  LiftRecord,
  classifyImport,
  fuzzyColumnMapper,
  parseCsvText,
  applyColumnOverrides,
  splitLiftRecordsByDestination,
  validateLiftImportSoft,
  validateLiftImport,
  buildLiftRecordsPreviewSoft,
  buildTrainingMaxPreview,
  buildTrainingMaxPreImage,
  liftRecordNaturalKey,
} from '@lifting-logbook/core';
import type { SpreadsheetCell } from '@lifting-logbook/core';
import { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { RepositoryBundle, IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { RlsTxTimeout } from '../adapters/prisma/rls-context';
import { IMPORT_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';
import { MAX_IMPORT_ROWS, readUploadedCsv } from './import-file.util';
import { IMPORT_HANDLERS } from './import-handlers';
import { effectiveSlotMapFor } from './effective-slot-map.util';

/**
 * Unified Smart Import endpoint (#477, #615).
 *
 * `mode=preview` classifies the file and returns a per-kind before→after preview
 * without writing. `mode=commit` re-parses the uploaded file server-side and writes
 * idempotently. Phase 3 adds column overrides, row exclusion, lift remapping for
 * ambiguous rows, 1RM split routing, and undo.
 */
@Controller('programs/:program')
export class ImportController {
  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
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
    @Query('excludeKeys') excludeKeysParam?: string,
    @Query('liftOverrides') liftOverridesParam?: string,
    @Query('splitDest') splitDestParam?: string,
  ): Promise<ImportPreviewResponse | ImportCommitResponse> {
    const csvText = await readUploadedCsv(req);
    let table = parseCsvText(csvText);

    const override = destinationParam && (Object.keys(IMPORT_HANDLERS) as ImportKind[]).includes(
      destinationParam as ImportKind,
    ) ? (destinationParam as ImportKind) : null;

    const columnOverrides = parseJsonParam<Record<string, string>>(overridesParam);

    if (mode === 'commit') {
      if (!override) {
        throw new BadRequestException('A valid `destination` is required to commit');
      }
      if (columnOverrides) {
        table = applyColumnOverrides(table, columnOverrides, override);
      }
      const excludeKeys = excludeKeysParam
        ? new Set(excludeKeysParam.split(',').map((k) => k.trim()).filter(Boolean))
        : new Set<string>();
      const liftOverrides = parseJsonParam<Record<string, string>>(liftOverridesParam) ?? {};
      const splitDest = splitDestParam === '1';
      const repos = await this.factory.forUser(user);
      return this.commit(program, override, table, repos, user.id, excludeKeys, liftOverrides, splitDest);
    }

    // Preview path
    const classification = classifyImport(table);
    const destination = override ?? classification.type;
    if (!destination) {
      return { classification, destination: null, columnMappings: null, preview: null, errors: [] };
    }

    if (columnOverrides) {
      table = applyColumnOverrides(table, columnOverrides, destination);
    }

    const columnMappings = fuzzyColumnMapper(table[0] ?? [], destination);
    const repos = await this.factory.forUser(user);

    // For lift-records, use soft validation so incomplete/ambiguous rows appear in REVIEW
    if (destination === 'lift-records') {
      return this.previewLiftRecords(program, classification, destination, table, columnMappings, repos);
    }

    const { errors, preview } = await this.preview(program, destination, table, repos);
    return {
      classification,
      destination,
      columnMappings,
      preview: errors.length ? null : preview,
      errors,
    };
  }

  @Post('import/:batchId/undo')
  @HttpCode(HttpStatus.OK)
  @RlsTxTimeout(IMPORT_TX_TIMEOUT_MS)
  async undoImport(
    @Param('program') program: string,
    @Param('batchId') batchId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportUndoResponse> {
    const repos = await this.factory.forUser(user);
    const batch = await repos.importBatch.findById(batchId, user.id);
    if (!batch || batch.program !== program) {
      throw new NotFoundException(`Import batch ${batchId} not found`);
    }

    let restored = 0;
    let skipped = 0;
    const flagged: Array<{ key: string; reason: string }> = [];

    // Hoist destination-specific reads before the loop to avoid N+1 per-key round-trips
    const allMaxes = batch.destination === 'training-maxes'
      ? await repos.trainingMax.getTrainingMaxes(program)
      : [];
    const allGoals = batch.destination === 'strength-goals'
      ? await repos.strengthGoal.getGoals(program)
      : [];

    if (batch.destination === 'lift-records') {
      // Collect all created keys and delete in a single query to avoid N+1 round-trips
      const createdKeys = Object.entries(batch.preImage)
        .filter(([, e]) => e.kind === 'created')
        .map(([k]) => k);
      if (createdKeys.length > 0) {
        const deleted = await repos.liftRecord.deleteLiftRecordsByNaturalKeys(program, createdKeys);
        restored += deleted;
        if (deleted < createdKeys.length) {
          const missing = createdKeys.length - deleted;
          skipped += missing;
          flagged.push({ key: '*', reason: `${missing} row(s) not found (already deleted?)` });
        }
      }
    } else {
      for (const [key, entry] of Object.entries(batch.preImage)) {
        if (batch.destination === 'training-maxes') {
          const lift = key;
          const current = allMaxes.find((m) => m.lift === lift);
          const wrote = entry.wrote as { weight: number };

          if (!current) {
            skipped++;
            flagged.push({ key, reason: 'training max no longer exists' });
            continue;
          }
          if (current.weight !== wrote.weight) {
            skipped++;
            flagged.push({ key, reason: `weight modified after import (expected ${wrote.weight}, found ${current.weight})` });
            continue;
          }

          if (entry.kind === 'created') {
            await repos.trainingMax.deleteTrainingMaxes(program, [lift]);
            restored++;
          } else if (entry.kind === 'updated') {
            const before = entry.before as { weight: number; dateUpdated: string };
            await repos.trainingMax.saveTrainingMaxes(program, [
              { lift: current.lift, weight: before.weight, dateUpdated: new Date(before.dateUpdated) },
            ]);
            restored++;
          }
        } else if (batch.destination === 'strength-goals') {
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
    }

    // Delete the batch record now that undo has been applied (best-effort; ignore failures)
    await repos.importBatch.deleteById(batchId, user.id);

    return { batchId, restored, skipped, flagged };
  }

  /** Preview for lift-records using soft validation (includes incomplete/ambiguous rows). */
  private async previewLiftRecords(
    program: string,
    classification: ReturnType<typeof classifyImport>,
    destination: ImportKind,
    table: SpreadsheetCell[][],
    columnMappings: ReturnType<typeof fuzzyColumnMapper>,
    repos: RepositoryBundle,
  ): Promise<ImportPreviewResponse> {
    const handler = IMPORT_HANDLERS['lift-records'];
    let parsed: LiftRecord[];
    try {
      parsed = handler.parse(table) as LiftRecord[];
    } catch (err) {
      return {
        classification,
        destination,
        columnMappings,
        preview: null,
        errors: [{ row: 0, message: `Could not parse file: ${(err as Error).message}` }],
      };
    }
    if (parsed.length > MAX_IMPORT_ROWS) {
      return {
        classification,
        destination,
        columnMappings,
        preview: null,
        errors: [{ row: 0, message: `Import exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. Split the file into smaller batches.` }],
      };
    }

    // Custom lifts are folded into the slot map fresh per request (#911) so a row whose
    // raw text already matches an existing custom lift's name resolves immediately
    // instead of being flagged ambiguous.
    const softResult = validateLiftImportSoft(parsed, await effectiveSlotMapFor(repos));
    if (softResult.hardErrors.length) {
      return { classification, destination, columnMappings, preview: null, errors: softResult.hardErrors };
    }

    const validWithProgram = softResult.valid.map((r) => ({ ...r, program }));
    const existing = await repos.liftRecord.findExistingRecords(program, validWithProgram);
    const preview = buildLiftRecordsPreviewSoft(softResult, existing);

    // Check for 1RM rows in the valid set
    const { trainingMaxes: splitMaxes } = splitLiftRecordsByDestination(validWithProgram);
    let split: ImportPreviewResponse['split'] | undefined;
    if (splitMaxes.length > 0) {
      const existingMaxes = await repos.trainingMax.getTrainingMaxes(program);
      split = {
        destination: 'training-maxes',
        preview: buildTrainingMaxPreview(splitMaxes, existingMaxes),
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
  ): Promise<{ errors: ImportError[]; preview: ImportPreviewResponse['preview'] }> {
    const { valid, errors } = this.parseAndValidate(destination, table);
    if (errors.length) return { errors, preview: null };
    const handler = IMPORT_HANDLERS[destination]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
    const previewResult = await handler.preview(valid as any, program, repos);
    return { errors, preview: previewResult };
  }

  /** Re-parse + validate + write for a destination (400 on validation errors). */
  private async commit(
    program: string,
    destination: ImportKind,
    table: SpreadsheetCell[][],
    repos: RepositoryBundle,
    userId: string,
    excludeKeys: Set<string>,
    liftOverrides: Record<string, string>,
    splitDest: boolean,
  ): Promise<ImportCommitResponse> {
    // Parse before any transforms: liftOverrides must remap before strict validation
    // because the strict validator rejects unknown-lift rows outright.
    const handler = IMPORT_HANDLERS[destination]!;
    let parsed: unknown[];
    try {
      parsed = handler.parse(table);
    } catch (err) {
      throw new BadRequestException({ message: `Could not parse file: ${(err as Error).message}` });
    }
    if (parsed.length > MAX_IMPORT_ROWS) {
      throw new BadRequestException({
        message: `Import exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. Split the file into smaller batches.`,
      });
    }

    // Apply lift overrides BEFORE strict validation so remapped names pass the slot map check
    if (destination === 'lift-records' && Object.keys(liftOverrides).length > 0) {
      parsed = (parsed as LiftRecord[]).map((r, i) => {
        const canonical = liftOverrides[String(i + 1)];
        return canonical ? { ...r, lift: canonical } : r;
      });
    }

    // Strict validation (with overrides applied). Lift-records gets a custom-lift-aware
    // slot map built fresh per request (#911), special-cased here rather than threading
    // extra context through the generic ImportHandler.validate signature — matching this
    // method's other per-destination special cases below (excludeKeys filtering, splitDest
    // partitioning). liftRecordsHandler.validate (import-handlers.ts) is unreachable for
    // this destination as a result, but stays in place to satisfy the ImportHandler<T>
    // interface the other three destinations still use.
    let rawValid: unknown[];
    let errors: ImportError[];
    if (destination === 'lift-records') {
      ({ valid: rawValid, errors } = validateLiftImport(parsed as LiftRecord[], await effectiveSlotMapFor(repos)));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
      ({ valid: rawValid, errors } = handler.validate(parsed as any));
    }
    if (errors.length > 0) {
      throw new BadRequestException({ message: 'Validation failed', errors });
    }
    let valid: unknown[] = rawValid;

    // Filter excluded keys
    if (excludeKeys.size > 0) {
      if (destination === 'lift-records') {
        valid = (valid as LiftRecord[]).filter((r) => !excludeKeys.has(liftRecordNaturalKey(r)));
      } else {
        // For upsert destinations, key = lift name; all non-lift-records types have a lift field.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Records from training-maxes/strength-goals/program-spec handlers share a `lift` field; no union type exists for these three.
        valid = valid.filter((r: any) => !excludeKeys.has(r.lift as string));
      }
    }

    // For splitDest, partition before committing to avoid double-writing 1RM rows as lift-records
    const validToCommit = (destination === 'lift-records' && splitDest)
      ? splitLiftRecordsByDestination(valid as LiftRecord[]).liftRecords
      : valid;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
    const { preImage, ...commitCounts } = await handler.commit(validToCommit as any, program, repos);

    // Phase 3: 1RM split for lift-records — commit the TM partition after lift-records
    let splitResult: ImportCommitResponse['split'] | undefined;
    if (destination === 'lift-records' && splitDest) {
      const { trainingMaxes } = splitLiftRecordsByDestination(valid as LiftRecord[]);
      if (trainingMaxes.length > 0) {
        const existingMaxes = await repos.trainingMax.getTrainingMaxes(program);
        const tmResult = await repos.trainingMax.importTrainingMaxes(program, trainingMaxes);
        const tmPreImage = buildTrainingMaxPreImage(trainingMaxes, existingMaxes);
        Object.assign(preImage, tmPreImage);
        splitResult = { destination: 'training-maxes', ...tmResult };
      }
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

  private parseAndValidate(
    destination: ImportKind,
    table: SpreadsheetCell[][],
  ): { valid: unknown[]; errors: ImportError[] } {
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
      return { valid: [], errors: [{ row: 0, message: `Could not parse file: ${(err as Error).message}` }] };
    }
    if (parsed.length > MAX_IMPORT_ROWS) {
      return {
        valid: [],
        errors: [{ row: 0, message: `Import exceeds the ${MAX_IMPORT_ROWS.toLocaleString()}-row limit. Split the file into smaller batches.` }],
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Handler signatures are generic across four types; type narrowing from destination covers safety
    return handler.validate(parsed as any);
  }
}

function parseJsonParam<T>(param: string | undefined): T | null {
  if (!param) return null;
  try {
    return JSON.parse(param) as T;
  } catch {
    throw new BadRequestException(`Invalid JSON in query parameter: ${param}`);
  }
}
