import {
  Controller,
  Get,
  Inject,
  Logger,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { CurrentUser } from '../auth/current-user.decorator';
import { SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { RlsContextService } from '../adapters/prisma/rls-context.service';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { buildExportFiles, exportFileName, rowCounts, zipExportFiles } from './build-data-export';

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
}
