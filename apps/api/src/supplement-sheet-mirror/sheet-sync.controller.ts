import { Controller, HttpCode, Post } from '@nestjs/common';
import { SkipRlsTransaction } from '../adapters/prisma/rls-context';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser } from '../ports/auth';
import { SupplementSheetMirrorTrigger } from './supplement-sheet-mirror.trigger';

/** Sync now (#1444, ADR-047 decision 16): enqueues a run at once for a user with a linked sheet. */
@Controller('integrations/google-sheet/sync')
export class SheetSyncController {
  constructor(private readonly trigger: SupplementSheetMirrorTrigger) {}

  @Post()
  @HttpCode(202)
  @SkipRlsTransaction()
  sync(@CurrentUser() user: AuthUser): Promise<{ queued: true }> {
    return this.trigger.syncNow(user);
  }
}
