import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Query,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { serializeLiftRecords } from '@lifting-logbook/core';
import { LiftRecordExportPartsResponse } from '@lifting-logbook/types';
import { CurrentUser } from '../auth/current-user.decorator';
import { SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory, RepositoryBundle } from '../ports/factory';
import { LiftRecordExportFilter } from '../ports/IUserDataExportRepository';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { buildExportFiles, exportFileName, rowCounts, zipExportFiles } from './build-data-export';
import {
  calendarDay,
  describeParts,
  exportParts,
  liftRecordExportFileName,
  splitFingerprint,
} from './lift-record-export';
import { LiftRecordExportDownloadQueryDto, LiftRecordExportQueryDto } from './lift-record-export.dto';

/** How long the reads may take. A long history reads many rows, on one connection. */
export const DATA_EXPORT_TX_TIMEOUT_MS = 30_000;

/**
 * Download My Data (#947): the user's whole logbook as one zip of re-importable CSVs and
 * `logbook.json`. Read-only. Logs row counts only, never row contents.
 *
 * The transaction covers the reads alone, so building the archive doesn't hold a pooled connection
 * or risk losing a finished archive at commit.
 */
@Controller('users/me/export')
export class DataExportController {
  private readonly logger = new Logger(DataExportController.name);

  constructor(
    @Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory,
    private readonly rlsContext: RlsContextService,
  ) {}

  @Get()
  @SkipRlsTransaction()
  async download(@CurrentUser() user: AuthUser): Promise<StreamableFile> {
    const started = Date.now();
    this.logger.log('Data export started (#947)');

    try {
      const rows = await this.rlsContext.withUserContext(
        async () => (await this.factory.forUser(user)).userDataExport.readAll(),
        DATA_EXPORT_TX_TIMEOUT_MS,
      );
      const now = new Date();
      const zip = await zipExportFiles(buildExportFiles(rows, now));

      this.logger.log(
        { rowCounts: rowCounts(rows), bytes: zip.length, durationMs: Date.now() - started },
        'Data export finished (#947)',
      );
      return new StreamableFile(Buffer.from(zip.buffer, zip.byteOffset, zip.length), {
        type: 'application/zip',
        disposition: `attachment; filename="${exportFileName(now)}"`,
      });
    } catch (err) {
      const code = err instanceof PrismaClientKnownRequestError ? err.code : undefined;
      this.logger.error({ durationMs: Date.now() - started, code }, 'Data export failed (#947)');
      if (code === 'P2028') {
        throw new ServiceUnavailableException(
          'Your data took too long to read, so nothing was downloaded. Please try again in a moment.',
        );
      }
      throw err;
    }
  }

  /**
   * How a filtered sets download splits into parts (#1308, decision 22), so the page can list one
   * download per part. Logs which filters were set and the counts, never their values.
   */
  @Get('lift-records/parts')
  @SkipRlsTransaction()
  async liftRecordParts(
    @CurrentUser() user: AuthUser,
    @Query() query: LiftRecordExportQueryDto,
  ): Promise<LiftRecordExportPartsResponse> {
    const started = Date.now();
    const parts = await this.readParts(user, query, started);
    const response = {
      rows: parts.reduce((n, p) => n + p.length, 0),
      parts: describeParts(parts),
      split: splitFingerprint(parts),
    };
    this.logger.log(
      { filters: filtersSet(query), rows: response.rows, parts: parts.length, durationMs: Date.now() - started },
      'Sets export parts listed (#1308)',
    );
    return response;
  }

  /**
   * One part of a filtered sets download (#1308): a CSV in decision 22's format, which `/import`
   * reads back. `part` defaults to 1, and a filter that takes no sets gives a header alone. With
   * the listing's `split`, a split that has changed since is a 409, so no macrocycle is missed.
   */
  @Get('lift-records')
  @SkipRlsTransaction()
  async downloadLiftRecords(
    @CurrentUser() user: AuthUser,
    @Query() query: LiftRecordExportDownloadQueryDto,
  ): Promise<StreamableFile> {
    const started = Date.now();
    const part = query.part === undefined ? 1 : Number(query.part);
    const parts = await this.readParts(user, query, started);
    if (query.split !== undefined && query.split !== splitFingerprint(parts)) {
      this.logger.warn({ filters: filtersSet(query), part, parts: parts.length }, 'Sets export split changed (#1308)');
      throw new ConflictException(
        'Your sets have changed since the parts were listed, so they may now be split differently. List the parts again and download each one.',
      );
    }
    if (part > Math.max(parts.length, 1)) {
      throw new NotFoundException(`This download has ${parts.length} part${parts.length === 1 ? '' : 's'}.`);
    }
    const rows = parts[part - 1] ?? [];
    const csv = serializeLiftRecords(rows);
    this.logger.log(
      { filters: filtersSet(query), rows: rows.length, part, parts: parts.length, durationMs: Date.now() - started },
      'Sets export downloaded (#1308)',
    );
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${liftRecordExportFileName(new Date(), part, parts.length)}"`,
    });
  }

  /** The transaction covers the reads alone, so splitting doesn't hold a pooled connection. */
  private async readParts(user: AuthUser, query: LiftRecordExportQueryDto, started: number) {
    let read;
    try {
      read = await this.rlsContext.withUserContext(async () => {
        const repos = await this.factory.forUser(user);
        const filter = await resolveFilter(query, repos);
        return {
          records: await repos.userDataExport.readLiftRecords(filter),
          macrocycles: await repos.macrocycle.listAll(),
        };
      }, DATA_EXPORT_TX_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const code = err instanceof PrismaClientKnownRequestError ? err.code : undefined;
      this.logger.error(
        { filters: filtersSet(query), code, durationMs: Date.now() - started },
        'Sets export failed (#1308)',
      );
      if (code === 'P2028') {
        throw new ServiceUnavailableException(
          'Your sets took too long to read, so nothing was downloaded. Please try again in a moment.',
        );
      }
      throw err;
    }
    return exportParts(read.records, read.macrocycles);
  }
}

/** Which filters a request set, for the log: their values can name a custom program. */
function filtersSet(query: LiftRecordExportQueryDto) {
  return {
    program: query.program !== undefined,
    macrocycle: query.macrocycle !== undefined,
    from: query.from !== undefined,
    to: query.to !== undefined,
  };
}

/**
 * The query as a repository filter. A macrocycle id names its program and number; a different
 * `program` beside it is a 400, and an id the user doesn't have a 404.
 */
async function resolveFilter(query: LiftRecordExportQueryDto, repos: RepositoryBundle): Promise<LiftRecordExportFilter> {
  const filter: LiftRecordExportFilter = {};
  if (query.program !== undefined) filter.program = query.program;
  if (query.macrocycle !== undefined) {
    const macrocycle = await repos.macrocycle.findById(query.macrocycle);
    if (!macrocycle) throw new NotFoundException('No macrocycle with that id.');
    if (filter.program !== undefined && filter.program !== macrocycle.program) {
      throw new BadRequestException('That macrocycle belongs to another program.');
    }
    filter.program = macrocycle.program;
    filter.macrocycleNum = macrocycle.macrocycleNum;
  }
  for (const end of ['from', 'to'] as const) {
    const text = query[end];
    if (text === undefined) continue;
    const day = calendarDay(text);
    if (!day) throw new BadRequestException(`${end} must be a real calendar date.`);
    filter[end] = day;
  }
  if (filter.from && filter.to && filter.from > filter.to) {
    throw new BadRequestException('from must be on or before to.');
  }
  return filter;
}
