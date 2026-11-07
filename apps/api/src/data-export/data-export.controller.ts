import { Controller, Get, Inject, Logger, StreamableFile } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { IMPORT_TX_TIMEOUT_MS } from '../adapters/prisma/prisma-tx.util';
import { RlsTxTimeout } from '../adapters/prisma/rls-context';
import { AuthUser } from '../ports/auth';
import { IRepositoryFactory } from '../ports/factory';
import { REPOSITORY_FACTORY } from '../ports/tokens';
import { buildExportFiles, exportFileName, rowCounts, zipExportFiles } from './build-data-export';

/**
 * Download My Data (#947): the user's whole logbook as one zip of re-importable CSVs and
 * `logbook.json`. Read-only. Logs row counts only, never row contents.
 */
@Controller('users/me/export')
export class DataExportController {
  private readonly logger = new Logger(DataExportController.name);

  constructor(@Inject(REPOSITORY_FACTORY) private readonly factory: IRepositoryFactory) {}

  // A long history reads many rows, so this gets the import path's transaction budget.
  @Get()
  @RlsTxTimeout(IMPORT_TX_TIMEOUT_MS)
  async download(@CurrentUser() user: AuthUser): Promise<StreamableFile> {
    const started = Date.now();
    this.logger.log('Data export started (#947)');

    const repos = await this.factory.forUser(user);
    const rows = await repos.userDataExport.readAll();
    const now = new Date();
    const zip = zipExportFiles(buildExportFiles(rows, now));

    this.logger.log(
      { rowCounts: rowCounts(rows), bytes: zip.length, durationMs: Date.now() - started },
      'Data export finished (#947)',
    );
    return new StreamableFile(Buffer.from(zip), {
      type: 'application/zip',
      disposition: `attachment; filename="${exportFileName(now)}"`,
    });
  }
}
