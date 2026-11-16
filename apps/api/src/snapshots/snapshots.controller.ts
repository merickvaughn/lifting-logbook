import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { serializeLiftRecords } from '@lifting-logbook/core';
import {
  ClearTrainingDataResponse,
  DataSnapshotSummary,
  LiftRecordExportPartsResponse,
  RestoreSnapshotResponse,
  TrainingDataCounts,
} from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { describeParts, exportParts, liftRecordExportFileName, splitFingerprint } from '../data-export/lift-record-export';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { StoredSnapshotSummary } from '../ports/IDataSnapshotRepository';
import { TRAINING_TABLES, liftRecordRows, macrocycleRows } from '../ports/ITrainingDataRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { ClearTrainingDataDto, SnapshotLiftRecordsQueryDto } from './training-data.dto';
import { clearTrainingData, restoreSnapshot } from './training-data.service';

/** How long clear, restore and a snapshot download may take. A long history is many rows. */
export const TRAINING_DATA_TX_TIMEOUT_MS = 30_000;

function total(counts: TrainingDataCounts): number {
  return TRAINING_TABLES.reduce((n, table) => n + counts[table], 0);
}

function toSummary(s: StoredSnapshotSummary): DataSnapshotSummary {
  return {
    id: s.id,
    kind: s.kind,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    counts: s.counts,
  };
}

/**
 * Clear data, and the snapshots it leaves (#1309, proposal decisions 20 and 21). Logs counts,
 * snapshot ids and timings, never row contents.
 */
@Controller('users/me')
export class SnapshotsController {
  private readonly logger = new Logger(SnapshotsController.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly rlsContext: RlsContextService,
  ) {}

  /** What Clear data would remove, for the lifter to confirm. */
  @Get('training-data/counts')
  async counts(@CurrentUser() user: AuthUser): Promise<TrainingDataCounts> {
    return (await this.factory.forUser(user)).trainingData.counts();
  }

  /**
   * Saves a snapshot, then clears the training data, in one transaction: if the snapshot can't
   * be saved, nothing is cleared (503). Counts that differ from what's stored are a 409.
   */
  @Post('training-data/clear')
  @SkipRlsTransaction()
  async clear(@CurrentUser() user: AuthUser, @Body() body: ClearTrainingDataDto): Promise<ClearTrainingDataResponse> {
    const started = Date.now();
    const snapshot = await this.run('clear', started, async () =>
      clearTrainingData(await this.factory.forUser(user), body.counts, new Date()),
    );
    this.logger.log(
      { snapshot: snapshot.id, rows: total(snapshot.counts), durationMs: Date.now() - started },
      'Training data cleared (#1309)',
    );
    return { snapshot: toSummary(snapshot) };
  }

  /** The user's snapshots that haven't expired, newest first. */
  @Get('snapshots')
  async list(@CurrentUser() user: AuthUser): Promise<DataSnapshotSummary[]> {
    return (await (await this.factory.forUser(user)).dataSnapshot.list(new Date())).map(toSummary);
  }

  /** Puts a snapshot's rows back without overwriting newer ones, then deletes it. */
  @Post('snapshots/:id/restore')
  @HttpCode(HttpStatus.OK)
  @SkipRlsTransaction()
  async restore(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RestoreSnapshotResponse> {
    const started = Date.now();
    const restored = await this.run('restore', started, async () =>
      restoreSnapshot(await this.factory.forUser(user), id, new Date()),
    );
    this.logger.log({ snapshot: id, rows: total(restored), durationMs: Date.now() - started }, 'Snapshot restored (#1309)');
    return { restored };
  }

  /** Deletes a snapshot now, before it expires. */
  @Delete('snapshots/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    if (!(await (await this.factory.forUser(user)).dataSnapshot.delete(id))) {
      throw new NotFoundException('No backup with that id.');
    }
    this.logger.log({ snapshot: id }, 'Snapshot deleted (#1309)');
  }

  /** How a snapshot's sets split into parts, as the filtered sets download lists them (#1308). */
  @Get('snapshots/:id/lift-records/parts')
  @SkipRlsTransaction()
  async liftRecordParts(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<LiftRecordExportPartsResponse> {
    const parts = await this.readParts(user, id);
    return { rows: parts.reduce((n, p) => n + p.length, 0), parts: describeParts(parts), split: splitFingerprint(parts) };
  }

  /** One part of a snapshot's sets as decision 22's CSV, which `/import` reads back. */
  @Get('snapshots/:id/lift-records')
  @SkipRlsTransaction()
  async downloadLiftRecords(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query() query: SnapshotLiftRecordsQueryDto,
  ): Promise<StreamableFile> {
    const part = query.part === undefined ? 1 : Number(query.part);
    const parts = await this.readParts(user, id);
    // A snapshot doesn't change, but the parts listed for one before a release that splits
    // differently would.
    if (query.split !== undefined && query.split !== splitFingerprint(parts)) {
      throw new ConflictException('This backup is now split differently. List its parts again and download each one.');
    }
    if (part > Math.max(parts.length, 1)) {
      throw new NotFoundException(`This download has ${parts.length} part${parts.length === 1 ? '' : 's'}.`);
    }
    const rows = parts[part - 1] ?? [];
    this.logger.log({ snapshot: id, rows: rows.length, part, parts: parts.length }, 'Snapshot sets downloaded (#1309)');
    return new StreamableFile(Buffer.from(serializeLiftRecords(rows), 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="backup-${liftRecordExportFileName(new Date(), part, parts.length)}"`,
    });
  }

  private async readParts(user: AuthUser, id: string) {
    const started = Date.now();
    const snapshot = await this.run('download', started, async () =>
      (await this.factory.forUser(user)).dataSnapshot.get(id, new Date()),
    );
    if (!snapshot) throw new NotFoundException('This backup has expired or was deleted.');
    return exportParts(liftRecordRows(snapshot.data), macrocycleRows(snapshot.data));
  }

  /** Runs `fn` in the user's RLS transaction, logging a failure and turning a timeout into a 503. */
  private async run<T>(action: 'clear' | 'restore' | 'download', started: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.rlsContext.withUserContext(fn, TRAINING_DATA_TX_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() < 500) throw err;
      const code = err instanceof PrismaClientKnownRequestError ? err.code : undefined;
      this.logger.error(
        { action, code, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) },
        'Training data action failed (#1309)',
      );
      if (code === 'P2028') {
        throw new ServiceUnavailableException('This took too long, so nothing changed. Please try again in a moment.');
      }
      throw err;
    }
  }
}
